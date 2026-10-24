"""HarnessAdapter for Hermes Agent, built against ADAPTERS.md section 3 (frozen).

Hermes is imported lazily inside run(), after HERMES_HOME and HERMES_YOLO_MODE are set,
because HERMES_YOLO_MODE is read once at import (tools/approval.py:46) and the module must
not be imported by the runner process at all.

Trace events come from Hermes lifecycle hooks (pre/post_api_request, api_request_error,
pre/post_tool_call) registered on the plugin manager, because they carry what the contract's
events need (call ids, durations, HTTP status, token usage). Every event is flushed as it
happens (H-7) and carries Hermes's own data; nothing is reconstructed after the run except
the result mapping.
"""
import importlib.util
import json
import os
import re
import subprocess
import threading
import time
from pathlib import Path
from typing import Any

from worker.adapters.base import (
    Capabilities,
    HarnessRunResult,
    MemorySnapshot,
    Settings,
    TrialContext,
    Usage,
)
from worker.trace import TraceWriter, write_events_fresh

MEMORY_CHAR_LIMIT = 2200   # hermes_cli/config_defaults.py:1334
USER_CHAR_LIMIT = 1375     # hermes_cli/config_defaults.py:1335
MEMORY_FILES = ("MEMORY.md", "USER.md")

# Hermes tool name -> platform tool (ADAPTERS 1, TraceEvent.tool). Anything else keeps its own name.
_PLATFORM_TOOL = {
    "terminal": "shell",
    "process_manage": "shell",
    "read_file": "files",
    "write_file": "files",
    "patch": "files",
    "search_files": "files",
}
_TOOLSET_FOR = {"shell": "terminal", "files": "file"}  # toolsets.py:102, :122
_ALWAYS_DISABLED = ("clarify", "web", "browser")        # toolsets.py:154, :76, :112
# agent/error_classifier.py FailoverReason -> the HTTP status it stands for, used only when the hook has no
# status_code. A reason that is not an HTTP error (a timeout, an SSL failure, a context overflow Hermes
# compresses itself) is absent: the failure has no status and the trial is scored.
_HINT_STATUS = re.compile(r"^Invalid API response after \d+ retries: (?:upstream [a-z ]*\((?:Cloudflare |code )?([45]\d\d)[,)]|rate limited by upstream provider \(([45]\d\d)\))")
_STATUS_FOR_REASON = {
    "rate_limit": 429, "upstream_rate_limit": 429,
    "server_error": 502, "overloaded": 503,
    "auth": 401, "auth_permanent": 401, "billing": 402, "upstream_blocked": 403, "provider_policy_blocked": 403,
    "model_entitlement": 403, "model_not_found": 404, "payload_too_large": 413,
    "format_error": 400, "role_alternation": 400,
}  # content_policy_blocked is absent on purpose: Hermes raises it for an HTTP 200 reply with finish_reason content_filter, a refusal and not an HTTP error


def _hermes_version() -> str:
    """Git commit short hash baked into the image (HERMES_ADAPTER_VERSION), else read from the checkout."""
    baked = os.environ.get("HERMES_ADAPTER_VERSION")
    if baked:
        return baked[:10]
    try:
        spec = importlib.util.find_spec("run_agent")  # does not import it
        if spec and spec.origin:
            out = subprocess.run(
                ["git", "-C", str(Path(spec.origin).parent), "rev-parse", "--short=10", "HEAD"],
                capture_output=True, text=True, timeout=10,
            )
            if out.returncode == 0 and out.stdout.strip():
                return out.stdout.strip()
    except Exception:  # noqa: BLE001 - version is informational when no checkout is present
        pass
    return "unknown"


def _yaml(d: dict[str, Any], indent: int = 0) -> str:
    """Nested mapping with JSON-encoded leaves. JSON scalars and arrays are valid YAML, and quoting
    every string keeps `off` and `on` from being read as booleans."""
    pad = "  " * indent
    lines = []
    for key, value in d.items():
        if isinstance(value, dict):
            lines.append(f"{pad}{key}:")
            lines.append(_yaml(value, indent + 1))
        else:
            lines.append(f"{pad}{key}: {json.dumps(value)}")
    return "\n".join(lines)


def hermes_config(ctx: TrialContext) -> dict[str, Any]:
    """The trial's config.yaml. Key paths: cli-config.yaml.example and hermes_cli/config_defaults.py."""
    s = ctx.settings
    seeded = s.memory.mode == "seeded"
    return {
        "model": {"default": ctx.model.slug, "provider": "openrouter", "context_length": ctx.model.context_window},
        "agent": {
            "max_turns": s.max_steps,
            "coding_context": "off",
            # Hermes clamps this to a minimum of 1, which is a single attempt (agent_init.py:1444),
            # so no retry happens that the trace cannot see (M-3). The post-exhaustion recovery
            # cycles (default 5, with waits of 15 to 60 s) are switched off for the same reason.
            "api_max_retries": 0,
            "auto_recovery_cycles": 0,
        },
        "memory": {"memory_enabled": seeded, "user_profile_enabled": seeded},
        "terminal": {"backend": "local"},
        "approvals": {"mode": "off"},
        "skills": {"auto_load": list(s.skills.preload)},
        # Off, so the model is offered exactly the tools of the configured toolsets and not the
        # tool_search/tool_describe/tool_call bridge that stands in for deferred ones (H-4).
        "tools": {"tool_search": {"enabled": "off"}},
    }


class HermesAdapter:
    id = "hermes"
    version = _hermes_version()
    capabilities = Capabilities(
        tools=frozenset({"shell", "files"}),
        memory_modes=frozenset({"off", "seeded"}),
        memory_writes=True,
        skills=True,
        temperature=True,
        seed=False,  # Hermes has no seed parameter; validate() does not reject a seed, it is unused
        system_prompt_capture=True,
    )

    # ------------------------------------------------------------------ validate

    def validate(self, settings: Settings) -> list[str]:
        problems: list[str] = []
        if not settings.tools:
            problems.append("tools is empty; hermes needs at least one of shell, files")
        for t in settings.tools:
            if t not in self.capabilities.tools:
                problems.append(f"tool {t!r} is not supported by hermes")
        if settings.memory.mode == "seeded":
            problems.extend(self._validate_fixture(settings))
        elif settings.memory.fixture is not None:
            problems.append("memory.fixture is set but memory.mode is off")
        if settings.skills.preload and not settings.skills.enabled:
            problems.append("skills.preload names skills but skills.enabled is false")
        if settings.max_steps < 1:
            problems.append("max_steps must be at least 1")
        if settings.max_output_tokens < 1:
            problems.append("max_output_tokens must be at least 1")
        if settings.timeout_seconds < 1:
            problems.append("timeout_seconds must be at least 1")
        for key in sorted(settings.harness_options):
            if key == "providers_ignored":
                value = settings.harness_options[key]
                if not isinstance(value, list) or not value or not all(isinstance(v, str) and v and v == v.strip() for v in value):
                    problems.append("harness_options.providers_ignored must be a non-empty list of provider names (OpenRouter routing)")
            else:
                problems.append(f"harness_options.{key} is not supported by hermes")
        return problems

    @staticmethod
    def _validate_fixture(settings: Settings) -> list[str]:
        name = settings.memory.fixture
        if not name:
            return ["memory.mode is seeded but memory.fixture is not set"]
        fixture = Path(os.environ.get("TASKS_DIR", "/tasks")) / "memory" / name
        if not fixture.is_dir():
            return [f"memory fixture {name!r} was not found on the worker"]
        problems = []
        for filename, limit in (("MEMORY.md", MEMORY_CHAR_LIMIT), ("USER.md", USER_CHAR_LIMIT)):
            path = fixture / filename
            if path.is_file():
                n = len(path.read_text(encoding="utf-8"))
                if n > limit:
                    problems.append(f"memory fixture {name!r} {filename} is {n} characters; hermes allows {limit}")
        return problems

    # ------------------------------------------------------------------ prepare

    def prepare(self, ctx: TrialContext) -> None:
        home = Path(ctx.trial_dir) / "hermes_home"
        for sub in ("memories", "skills", "sessions", "logs"):
            (home / sub).mkdir(parents=True, exist_ok=True)
        (home / "config.yaml").write_text(_yaml(hermes_config(ctx)) + "\n", encoding="utf-8", newline="\n")

        events: list[dict[str, Any]] = []
        if ctx.settings.memory.mode == "seeded":
            seed = ctx.memory_seed or {}
            for filename, limit in (("MEMORY.md", MEMORY_CHAR_LIMIT), ("USER.md", USER_CHAR_LIMIT)):
                content = seed.get(filename)
                if content is None:
                    continue
                if len(content) > limit:
                    raise ValueError(f"{filename} seed is {len(content)} characters; hermes allows {limit} (validate() should have refused it)")
                (home / "memories" / filename).write_text(content, encoding="utf-8", newline="\n")
                events.append({"kind": "memory_read", "file": filename, "content": content, "loaded_by": "harness"})
        # Rewritten from scratch so calling prepare() twice leaves identical bytes (H-5).
        write_events_fresh(ctx.events_path, events)

    # ------------------------------------------------------------------ run

    def run(self, ctx: TrialContext) -> HarnessRunResult:
        home = Path(ctx.trial_dir) / "hermes_home"
        os.environ["HERMES_HOME"] = str(home)
        os.environ["HERMES_YOLO_MODE"] = "1"  # read once at import, so before `import run_agent`
        # Hermes re-sends a failed streamed request on its own (agent/chat_completion_helpers.py:3740,
        # default 2). Off, so every request that reaches the provider is one the hooks see (M-3).
        os.environ["HERMES_STREAM_RETRIES"] = "0"
        os.chdir(ctx.workspace_dir)

        writer = TraceWriter(ctx.events_path)
        recorder = _Recorder(writer, ctx)
        notes: list[str] = []

        from run_agent import AIAgent  # noqa: PLC0415 - must follow the env above

        recorder.install_hooks()

        seeded = ctx.settings.memory.mode == "seeded"
        enabled = [_TOOLSET_FOR[t] for t in ctx.settings.tools]
        disabled = list(_ALWAYS_DISABLED)
        if seeded:
            enabled.append("memory")
        else:
            disabled.append("memory")
        if not ctx.settings.skills.enabled:
            disabled.append("skills")
        else:
            enabled.append("skills")
        for name in ctx.settings.skills.preload:
            writer.emit("skill_invoked", name=name, via="preload")
        if ctx.settings.skills.enabled:
            # A bare programmatic AIAgent does not seed bundled skills into a fresh HERMES_HOME (A-4).
            from tools.skills_sync import sync_skills  # noqa: PLC0415

            sync_skills(quiet=True)

        agent = AIAgent(
            model=ctx.model.slug,
            base_url=ctx.model.base_url,
            api_key=os.environ[ctx.model.api_key_env],  # explicit pair: used directly (agent_init.py:993)
            provider="openrouter",
            max_iterations=ctx.settings.max_steps,
            enabled_toolsets=enabled,
            disabled_toolsets=disabled,
            max_tokens=ctx.settings.max_output_tokens,
            request_overrides={"temperature": ctx.settings.temperature},
            skip_context_files=True,
            skip_memory=not seeded,
            skip_background_review=True,
            save_trajectories=False,
            quiet_mode=True,
            cwd=ctx.workspace_dir,
            run_budget_seconds=ctx.settings.timeout_seconds,
            session_id=f"{ctx.trial_id}-{ctx.attempt}",
            clarify_callback=lambda *a, **k: "pick defaults",
            # OpenRouter routing: providers the request must not be sent to (provider.ignore).
            providers_ignored=list(ctx.settings.harness_options["providers_ignored"]) if ctx.settings.harness_options.get("providers_ignored") else None,
        )
        try:
            try:
                result = agent.run_conversation(ctx.task.prompt)
            except Exception as e:  # noqa: BLE001 - H-6: a model- or tool-side failure is a scored outcome
                recorder.finish()
                writer.emit("error", stage="run", message=f"{type(e).__name__}: {e}", retryable=False)
                return self._result(None, "agent_error", recorder, None, notes + [f"run_conversation raised {type(e).__name__}"], ctx)
            recorder.finish()
            if recorder.system_prompt is None:
                recorder.system_prompt = getattr(agent, "_cached_system_prompt", None)
            return self._map_result(result, recorder, notes, writer, ctx)
        finally:
            try:
                agent.close()
            except Exception:  # noqa: BLE001
                pass
            recorder.close()

    # ------------------------------------------------------------------ result mapping

    def _map_result(self, result: dict[str, Any], rec: "_Recorder", notes: list[str], writer: TraceWriter, ctx: TrialContext) -> HarnessRunResult:
        reason = str(result.get("turn_exit_reason") or "")
        # Hermes marks a failed result `partial` when it delivered some text before the provider gave out
        # (agent/turn_recovery.py `_with_delivered_partial`). If an HTTP error ended that run it is an
        # agent_error with a status, not an invalid tool call; exhausted context compression keeps its old reading.
        http_failed = bool(result.get("failed")) and result.get("failure_reason") != "context_overflow" and rec.last_error_status(str(result.get("error") or ""))[0] is not None
        if reason.startswith("max_iterations_reached") or reason == "budget_exhausted":
            exit_reason = "max_steps"
        elif result.get("partial") and not http_failed:
            exit_reason = "invalid_tool_call"
        elif result.get("completed"):
            exit_reason = "completed"
        else:
            exit_reason = "agent_error"
            notes.append(f"hermes turn_exit_reason: {reason}")
            error = result.get("error") or reason or "hermes ended the turn without completing"
            status, source = rec.last_error_status(str(error))
            # The final error event carries the HTTP status the failure amounts to; the runner turns a 4xx or
            # 5xx into an errored trial and leaves a failure with no status scored (DESIGN 11 entry 17).
            writer.emit(
                "error", stage="run", message=str(error), retryable=status == 429 or (status or 0) >= 500,
                http_status=status, http_status_source=source,
            )
        return self._result(self._verbatim(result.get("final_response"), rec), exit_reason, rec, result, notes, ctx)

    @staticmethod
    def _verbatim(final: Any, rec: "_Recorder") -> str | None:
        """Hermes strips whitespace from final_response (H-11 wants the message untrimmed). The
        hook sees the model's reply as received, so use it when it is demonstrably that same reply."""
        raw = rec.last_content
        if isinstance(final, str) and isinstance(raw, str) and raw.strip() == final.strip():
            return raw
        return final

    def _result(self, final: str | None, exit_reason: str, rec: "_Recorder", result: dict[str, Any] | None, notes: list[str], ctx: TrialContext) -> HarnessRunResult:
        steps = rec.ok_calls
        if result is not None and int(result.get("api_calls") or 0) != steps:
            notes.append(f"hermes reported api_calls={result.get('api_calls')} but {steps} api_call events had status ok")
        cost = (result or {}).get("estimated_cost_usd")
        return HarnessRunResult(
            final_response=final,
            exit_reason=exit_reason,  # type: ignore[arg-type]
            steps=steps,
            usage=Usage(
                input_tokens=int((result or {}).get("input_tokens") or rec.input_tokens),
                output_tokens=int((result or {}).get("output_tokens") or rec.output_tokens),
                cache_read_tokens=(result or {}).get("cache_read_tokens"),
                reasoning_tokens=(result or {}).get("reasoning_tokens"),
                api_calls=steps,
            ),
            harness_reported_cost_usd=float(cost) if isinstance(cost, (int, float)) else None,
            system_prompt=rec.system_prompt,
            skills_invoked=tuple(dict.fromkeys([*ctx.settings.skills.preload, *rec.skills_invoked])),
            notes=tuple(notes),
        )

    # ------------------------------------------------------------------ collect_memory

    def collect_memory(self, ctx: TrialContext) -> MemorySnapshot:
        if ctx.settings.memory.mode != "seeded":
            return MemorySnapshot(files={})
        return MemorySnapshot(files=_read_memory_files(Path(ctx.trial_dir) / "hermes_home" / "memories"))


def _read_memory_files(memories: Path) -> dict[str, str]:
    files: dict[str, str] = {}
    for name in MEMORY_FILES:
        p = memories / name
        if p.is_file():
            files[name] = p.read_text(encoding="utf-8")
    return files


class _Recorder:
    """Turns Hermes lifecycle hooks into TraceEvents and keeps the counters the result needs."""

    def __init__(self, writer: TraceWriter, ctx: TrialContext):
        self._w = writer
        self._ctx = ctx
        self._lock = threading.Lock()
        self.ok_calls = 0
        self.input_tokens = 0
        self.output_tokens = 0
        self.system_prompt: str | None = None
        self.skills_invoked: list[str] = []
        self._intro_done = False
        self._step = 0
        self.last_content: str | None = None  # the model's last reply exactly as received
        self._open: tuple[int, float] | None = None  # (step, started) of a request with no outcome yet
        self._last_error_status: int | None = None
        self._last_error_reason: str | None = None
        self._last_error_seen = False
        self._closed = False

    # -- registration -----------------------------------------------------------------

    def install_hooks(self) -> None:
        from hermes_cli import plugins  # noqa: PLC0415

        manager = plugins.get_plugin_manager()
        discover = getattr(manager, "discover_and_load", None)
        if discover is not None and not getattr(manager, "_discovered", True):
            discover()  # discovery first, so it cannot replace what we register after it
        for name, fn in (
            ("pre_api_request", self.pre_api_request),
            ("post_api_request", self.post_api_request),
            ("api_request_error", self.api_request_error),
            ("pre_tool_call", self.pre_tool_call),
            ("post_tool_call", self.post_tool_call),
        ):
            manager._hooks.setdefault(name, []).append(fn)

    def close(self) -> None:
        with self._lock:
            self._closed = True
        self._w.close()

    def _emit(self, kind: str, **fields: Any) -> None:
        with self._lock:
            if self._closed:
                return
        self._w.emit(kind, **fields)

    # -- api calls --------------------------------------------------------------------

    def pre_api_request(self, system_prompt: Any = None, api_call_count: int = 0, **_: Any) -> None:
        with self._lock:
            self._step = api_call_count
            first = not self._intro_done
            self._intro_done = True
            if first and isinstance(system_prompt, str):
                self.system_prompt = system_prompt
            stale, self._open = self._open, (api_call_count, time.monotonic())
        if stale is not None:
            # The previous request got a response Hermes threw away (an invalid or truncated tool
            # call) and re-sent. No hook fires for that, so the request is closed out here.
            self._emit_unresolved(stale, "retry")
        if first:
            if isinstance(system_prompt, str):
                self._emit("message", role="system", content=system_prompt, step=api_call_count)
            self._emit("message", role="user", content=self._ctx.task.prompt, step=api_call_count)

    def post_api_request(self, api_call_count: int = 0, api_duration: float = 0.0, usage: Any = None,
                         assistant_message: Any = None, **_: Any) -> None:
        usage = usage if isinstance(usage, dict) else {}
        n_in = int(usage.get("prompt_tokens") or usage.get("input_tokens") or 0)
        n_out = int(usage.get("output_tokens") or 0)
        with self._lock:
            self._open = None
            self._last_error_seen = False  # a reply arrived: an earlier failure was recovered from
            self.ok_calls += 1
            self.input_tokens += n_in
            self.output_tokens += n_out
        self._emit(
            "api_call", step=api_call_count, model=self._ctx.model.slug, input_tokens=n_in, output_tokens=n_out,
            latency_ms=int(api_duration * 1000), status="ok", http_status=200,
        )
        content = getattr(assistant_message, "content", None)
        if isinstance(content, str) and content:
            with self._lock:
                self.last_content = content
            self._emit("message", role="assistant", content=content, step=api_call_count)

    def api_request_error(self, api_call_count: int = 0, api_duration: float = 0.0, status_code: int | None = None,
                          retry_count: int | None = None, max_retries: int | None = None, retryable: bool | None = None,
                          reason: str | None = None, **_: Any) -> None:
        will_retry = bool(retryable) and retry_count is not None and max_retries is not None and retry_count + 1 < max_retries
        with self._lock:
            self._open = None
            self._last_error_status = status_code
            self._last_error_reason = reason
            self._last_error_seen = True
        self._emit(
            "api_call", step=api_call_count, model=self._ctx.model.slug, input_tokens=0, output_tokens=0,
            latency_ms=int(api_duration * 1000), status="retry" if will_retry else "error", http_status=status_code,
        )

    def _emit_unresolved(self, opened: tuple[int, float], status: str) -> None:
        step, started = opened
        self._emit(
            "api_call", step=step, model=self._ctx.model.slug, input_tokens=0, output_tokens=0,
            latency_ms=int((time.monotonic() - started) * 1000), status=status, http_status=None,
        )

    def finish(self) -> None:
        """Called when run_conversation returns: a request still open never got a usable response."""
        with self._lock:
            opened, self._open = self._open, None
        if opened is not None:
            self._emit_unresolved(opened, "error")

    def last_error_status(self, final_message: str = "") -> tuple[int | None, str | None]:
        """(HTTP status, where it came from) of the failure that ended the run, or (None, None).

        1. The hook's own status_code, when there is one.
        2. OpenRouter reports an upstream failure that happens after it answered 200 (a streamed reply, a
           provider that went away) as an error object in the body, and Hermes then has no status_code.
           Its own classification of the error (`reason`) names the class of HTTP error, and that is mapped
           to a representative status.
        3. For an invalid or empty response Hermes has only text: its hint for the provider's error code,
           "upstream server error (502, 2s)" and the like (agent/turn_recovery.py `_failure_hint_for`),
           which ends up in the final error message.
        Otherwise there is no status, and the runner scores the trial."""
        with self._lock:
            if not self._last_error_seen:
                return None, None
            status, reason = self._last_error_status, self._last_error_reason
        if isinstance(status, int):
            return status, "http"
        if reason in _STATUS_FOR_REASON:
            return _STATUS_FOR_REASON[reason], f"hermes_reason:{reason}"
        m = _HINT_STATUS.match(final_message) if reason == "invalid_response" else None
        if m:
            return int(m.group(1) or m.group(2)), "hermes_hint"
        return None, None

    # -- tools ------------------------------------------------------------------------

    def pre_tool_call(self, tool_name: str = "", args: Any = None, tool_call_id: str = "", **_: Any) -> None:
        self._emit(
            "tool_call", call_id=tool_call_id, step=self._step, tool=_PLATFORM_TOOL.get(tool_name, tool_name),
            harness_tool=tool_name, args=args if isinstance(args, dict) else {},
        )
        if tool_name == "skill_view" and isinstance(args, dict) and args.get("name"):
            name = str(args["name"])
            self.skills_invoked.append(name)
            self._emit("skill_invoked", name=name, via="tool")

    def post_tool_call(self, tool_name: str = "", args: Any = None, result: Any = None, tool_call_id: str = "",
                       duration_ms: int = 0, status: str | None = None, **_: Any) -> None:
        output = result if isinstance(result, str) else json.dumps(result, ensure_ascii=False, default=str)
        self._emit("tool_result", call_id=tool_call_id, output=output, is_error=(status == "error"), duration_ms=int(duration_ms or 0))
        if tool_name == "memory" and isinstance(args, dict):
            target = args.get("target", "memory")
            filename = "USER.md" if target == "user" else "MEMORY.md"
            memories = Path(self._ctx.trial_dir) / "hermes_home" / "memories"
            path = memories / filename
            self._emit(
                "memory_write", file=filename, op=str(args.get("action", "")), args=args,
                content_after=path.read_text(encoding="utf-8") if path.is_file() else None,
            )
