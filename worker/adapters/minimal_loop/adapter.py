"""HarnessAdapter for the baseline tool-calling loop, written against ADAPTERS.md section 4
(frozen) after the Hermes adapter. It shares no code with it: only the contract.

Loop: call the model; no tool calls means completed; otherwise run each tool call, append the
results and repeat, up to max_steps model calls. Tools are the platform names `shell` and
`files` (read_file, write_file, list_dir). A call that cannot be executed because its
arguments are not a JSON object, lack a required string, or name a tool that was not offered
is a malformed call: it gets an error tool result and counts against the step budget, and 3 in
a row end the trial as invalid_tool_call. A call that is well formed and fails (a missing file,
a path outside the workspace, a non-zero exit) is an ordinary error result, not malformed.
"""
import json
import os
import signal
import subprocess
import time
from pathlib import Path
from typing import Any

import openai

from worker.adapters.base import (
    Capabilities,
    HarnessRunResult,
    MemorySnapshot,
    Settings,
    TrialContext,
    Usage,
)
from worker.adapters.minimal_loop.prompt import PROMPT_SHA256, SYSTEM_PROMPT
from worker.models import make_client
from worker.trace import TraceWriter, write_events_fresh

MEMORY_FILES = ("MEMORY.md", "USER.md")
BACKOFF_SECONDS = (1, 2, 4, 8, 16)  # DESIGN 6.3: 429, 5xx and dropped connections wait and retry
REQUEST_TIMEOUT_SECONDS = 120.0
SHELL_TIMEOUT_SECONDS = 60
MAX_TOOL_OUTPUT_CHARS = 10_000
MALFORMED_LIMIT = 3

_PLATFORM_TOOL = {"shell": "shell", "read_file": "files", "write_file": "files", "list_dir": "files"}
_TOOLS_FOR = {"shell": ("shell",), "files": ("read_file", "write_file", "list_dir")}
_PARAMS = {  # tool name -> (description, required string parameters)
    "shell": ("Run a shell command in the workspace directory. Returns its combined output.", ("cmd",)),
    "read_file": ("Read a text file in the workspace.", ("path",)),
    "write_file": ("Write a text file in the workspace, replacing it if it exists.", ("path", "content")),
    "list_dir": ("List a directory in the workspace. Directories end with a slash.", ("path",)),
}


def _tool_schema(name: str) -> dict[str, Any]:
    description, required = _PARAMS[name]
    return {
        "type": "function",
        "function": {
            "name": name,
            "description": description,
            "parameters": {"type": "object", "properties": {p: {"type": "string"} for p in required}, "required": list(required)},
        },
    }


class _Malformed(Exception):
    """The call cannot be executed as written."""


class _ProviderFailure(Exception):
    def __init__(self, status: int | None, message: str):
        super().__init__(message)
        self.status = status


class MinimalLoopAdapter:
    id = "minimal_loop"
    version = f"1.0.0+{PROMPT_SHA256[:8]}"
    capabilities = Capabilities(
        tools=frozenset({"shell", "files"}),
        memory_modes=frozenset({"off", "seeded"}),
        memory_writes=False,
        skills=False,
        temperature=True,
        seed=True,  # sent on every call; whether the provider honors it is per model (STATE A-8)
        system_prompt_capture=True,
    )

    # ------------------------------------------------------------------ validate

    def validate(self, settings: Settings) -> list[str]:
        problems: list[str] = []
        if not settings.tools:
            problems.append("tools is empty; the minimal loop needs at least one of shell, files")
        for t in settings.tools:
            if t not in self.capabilities.tools:
                problems.append(f"tool {t!r} is not supported by the minimal loop")
        if settings.memory.mode == "seeded":
            name = settings.memory.fixture
            if not name:
                problems.append("memory.mode is seeded but memory.fixture is not set")
            elif not (Path(os.environ.get("TASKS_DIR", "/tasks")) / "memory" / name).is_dir():
                problems.append(f"memory fixture {name!r} was not found on the worker")
        elif settings.memory.fixture is not None:
            problems.append("memory.fixture is set but memory.mode is off")
        if settings.skills.enabled:
            problems.append("the minimal loop has no skills; skills.enabled must be false")
        if settings.skills.preload:
            problems.append("skills.preload names skills but the minimal loop has none")
        if not 0 <= settings.temperature <= 2:
            problems.append("temperature must be between 0 and 2; providers reject or silently clamp anything else")
        for label, value in (("max_steps", settings.max_steps), ("max_output_tokens", settings.max_output_tokens), ("timeout_seconds", settings.timeout_seconds)):
            if value < 1:
                problems.append(f"{label} must be at least 1")
        for key in sorted(settings.harness_options):
            problems.append(f"harness_options.{key} is not supported by the minimal loop")
        return problems

    # ------------------------------------------------------------------ prepare / collect_memory

    def prepare(self, ctx: TrialContext) -> None:
        # Outside the workspace, but on the same filesystem as a shell the agent runs (no sandbox, DESIGN 13).
        memory_dir = Path(ctx.trial_dir) / "memory"
        events: list[dict[str, Any]] = []
        if ctx.settings.memory.mode == "seeded":
            memory_dir.mkdir(parents=True, exist_ok=True)
            for filename in MEMORY_FILES:
                content = (ctx.memory_seed or {}).get(filename)
                if content is None:
                    continue
                (memory_dir / filename).write_text(content, encoding="utf-8", newline="\n")
                events.append({"kind": "memory_read", "file": filename, "content": content, "loaded_by": "adapter"})
        write_events_fresh(ctx.events_path, events)  # rewritten whole, so a second call changes nothing (H-5)

    def collect_memory(self, ctx: TrialContext) -> MemorySnapshot:
        if ctx.settings.memory.mode != "seeded":
            return MemorySnapshot(files={})
        memory_dir = Path(ctx.trial_dir) / "memory"
        return MemorySnapshot(files={f: (memory_dir / f).read_text(encoding="utf-8") for f in MEMORY_FILES if (memory_dir / f).is_file()})

    # ------------------------------------------------------------------ run

    def run(self, ctx: TrialContext) -> HarnessRunResult:
        writer = TraceWriter(ctx.events_path)
        spawned: list[int] = []
        try:
            return self._loop(ctx, writer, spawned)
        finally:
            writer.close()
            _kill_leftovers(spawned)

    def _system_prompt(self, ctx: TrialContext) -> str:
        if ctx.settings.memory.mode != "seeded":
            return SYSTEM_PROMPT
        seed = ctx.memory_seed or {}
        return f"{SYSTEM_PROMPT}\n\n## Memory\n{seed.get('MEMORY.md', '')}\n## User\n{seed.get('USER.md', '')}"

    def _loop(self, ctx: TrialContext, w: TraceWriter, spawned: list[int]) -> HarnessRunResult:
        s = ctx.settings
        client = make_client(ctx.model)
        tools = [_tool_schema(name) for t in s.tools for name in _TOOLS_FOR[t]]
        offered = {t["function"]["name"] for t in tools}
        system = self._system_prompt(ctx)
        messages: list[dict[str, Any]] = [{"role": "system", "content": system}, {"role": "user", "content": ctx.task.prompt}]
        w.emit("message", role="system", content=system, step=0)
        w.emit("message", role="user", content=ctx.task.prompt, step=0)

        usage = {"in": 0, "out": 0, "cache": None, "reasoning": None}
        steps = 0
        malformed_run = 0
        last_text: str | None = None
        notes: list[str] = []

        def result(reason: str, final: str | None, extra_notes: tuple[str, ...] = ()) -> HarnessRunResult:
            return HarnessRunResult(
                final_response=final,
                exit_reason=reason,  # type: ignore[arg-type]
                steps=steps,
                usage=Usage(usage["in"], usage["out"], usage["cache"], usage["reasoning"], steps),
                harness_reported_cost_usd=None,
                system_prompt=system,
                skills_invoked=(),
                notes=(*extra_notes, *notes),
            )

        for step in range(1, s.max_steps + 1):
            try:
                resp = self._call_model(client, ctx, messages, tools, step, w)
            except _ProviderFailure as e:
                # retryable=true for every provider failure: the runner turns it into an errored
                # trial (never a scored failure) and picks the class from the last call's status.
                w.emit("error", stage="run", message=str(e), retryable=True)
                return result("agent_error", last_text, (f"provider failure: {e}",))
            steps += 1
            u = resp.usage
            usage["in"] += int(getattr(u, "prompt_tokens", 0) or 0)
            usage["out"] += int(getattr(u, "completion_tokens", 0) or 0)
            cached = getattr(getattr(u, "prompt_tokens_details", None), "cached_tokens", None)
            reasoning = getattr(getattr(u, "completion_tokens_details", None), "reasoning_tokens", None)
            if cached is not None:
                usage["cache"] = (usage["cache"] or 0) + int(cached)
            if reasoning is not None:
                usage["reasoning"] = (usage["reasoning"] or 0) + int(reasoning)

            msg = resp.choices[0].message
            content = _clean(msg.content) if isinstance(msg.content, str) else None
            calls = list(msg.tool_calls or [])
            if getattr(resp.choices[0], "finish_reason", None) == "length" and not calls:
                notes.append(f"step {step}: the reply was cut off at max_output_tokens ({s.max_output_tokens}); it is recorded as completed")
            if content:
                last_text = content
                w.emit("message", role="assistant", content=content, step=step)
            if not calls:
                return result("completed", content if content is not None else "")

            history_calls: list[dict[str, Any]] = []
            tool_messages: list[dict[str, Any]] = []
            for call in calls:
                name, raw_args = _clean(call.function.name or ""), _clean(call.function.arguments or "")
                call_id = call.id or f"call_{step}_{len(history_calls)}"
                started = time.monotonic()
                try:
                    args = self._parse_args(name, raw_args, offered)
                    w.emit("tool_call", call_id=call_id, step=step, tool=_PLATFORM_TOOL[name], harness_tool=name, args=args)
                    output, is_error = self._execute(name, args, ctx.workspace_dir, spawned)
                    malformed_run = 0
                    history_args = raw_args
                except _Malformed as e:
                    malformed_run += 1
                    w.emit("tool_call", call_id=call_id, step=step, tool=_PLATFORM_TOOL.get(name, name), harness_tool=name, args={"raw_arguments": raw_args})
                    output, is_error = f"error: {e}", True
                    history_args = "{}"  # providers reject invalid JSON in the history; the trace keeps the raw text
                w.emit("tool_result", call_id=call_id, output=output, is_error=is_error, duration_ms=int((time.monotonic() - started) * 1000))
                history_calls.append({"id": call_id, "type": "function", "function": {"name": name, "arguments": history_args}})
                tool_messages.append({"role": "tool", "tool_call_id": call_id, "content": output})
                if malformed_run >= MALFORMED_LIMIT:
                    return result("invalid_tool_call", last_text)
            messages.append({"role": "assistant", "content": content or "", "tool_calls": history_calls})
            messages.extend(tool_messages)

        return result("max_steps", last_text)

    # ------------------------------------------------------------------ model call

    def _call_model(self, client: openai.OpenAI, ctx: TrialContext, messages: list, tools: list, step: int, w: TraceWriter) -> Any:
        """One logical model call. Every request that reaches the provider is an api_call event: a
        failed one with status retry (a wait follows) or error (the last), then the ok one (M-3)."""
        for attempt in range(len(BACKOFF_SECONDS) + 1):
            started = time.monotonic()
            status: int | None = None
            try:
                resp = client.with_options(timeout=REQUEST_TIMEOUT_SECONDS).chat.completions.create(
                    model=ctx.model.slug,
                    messages=messages,
                    tools=tools,
                    temperature=ctx.settings.temperature,
                    max_tokens=ctx.settings.max_output_tokens,
                    seed=ctx.seed,
                )
                if not resp.choices:
                    raise _ProviderFailure(None, "the provider returned a response with no choices")
            except openai.APIStatusError as e:
                status, reason = e.status_code, f"HTTP {e.status_code}: {e.message}"
            except openai.APIConnectionError as e:
                reason = f"connection error: {type(e).__name__}"
            except openai.APIError as e:  # a body that is not a chat completion
                reason = f"unusable response: {type(e).__name__}"
            except _ProviderFailure as e:
                status, reason = e.status, str(e)
            else:
                u = resp.usage
                w.emit(
                    "api_call", step=step, model=ctx.model.slug, input_tokens=int(getattr(u, "prompt_tokens", 0) or 0),
                    output_tokens=int(getattr(u, "completion_tokens", 0) or 0), latency_ms=int((time.monotonic() - started) * 1000),
                    status="ok", http_status=200,
                )
                return resp
            retryable = status is None or status == 429 or status >= 500
            will_retry = retryable and attempt < len(BACKOFF_SECONDS)
            w.emit(
                "api_call", step=step, model=ctx.model.slug, input_tokens=0, output_tokens=0,
                latency_ms=int((time.monotonic() - started) * 1000), status="retry" if will_retry else "error", http_status=status,
            )
            if not will_retry:
                raise _ProviderFailure(status, reason)
            time.sleep(BACKOFF_SECONDS[attempt])
        raise AssertionError("unreachable")

    # ------------------------------------------------------------------ tools

    @staticmethod
    def _parse_args(name: str, raw: str, offered: set[str]) -> dict[str, str]:
        if name not in offered:
            raise _Malformed(f"unknown tool {name!r}; the tools are {sorted(offered)}")
        try:
            args = json.loads(raw)
        except ValueError as e:
            raise _Malformed(f"the arguments are not valid JSON ({e}); received: {raw[:200]!r}") from e
        if not isinstance(args, dict):
            raise _Malformed("the arguments must be a JSON object")
        for param in _PARAMS[name][1]:
            if not isinstance(args.get(param), str):
                raise _Malformed(f"the argument {param!r} is required and must be a string")
        return args

    def _execute(self, name: str, args: dict[str, str], workspace: str, spawned: list[int]) -> tuple[str, bool]:
        try:
            if name == "shell":
                output, is_error = _run_shell(args["cmd"], workspace, spawned)
            else:
                output, is_error = _run_file_tool(name, args, Path(workspace))
        except (OSError, ValueError, subprocess.SubprocessError) as e:  # the tool could not run (a NUL in a path, say): a result, not a crash (H-6)
            output, is_error = f"error: {type(e).__name__}: {e}", True
        return _clean(output), is_error


def _cut(text: str) -> str:
    """Keeps the head and the tail of long output (a traceback or a test summary is at the end)."""
    if len(text) <= MAX_TOOL_OUTPUT_CHARS:
        return text
    half = MAX_TOOL_OUTPUT_CHARS // 2
    return f"{text[:half]}\n[{len(text) - 2 * half} characters omitted]\n{text[-half:]}"


def _shell_env() -> dict[str, str]:
    """The child's environment without the provider keys: the agent has no use for them (M-4)."""
    return {k: v for k, v in os.environ.items() if not k.upper().endswith(("_API_KEY", "_TOKEN", "_SECRET"))}


def _kill_leftovers(pids: list[int]) -> None:
    """A command the agent backgrounded (`&`, nohup) outlives its shell. Kill each shell's process group at the end of the trial."""
    for pid in pids:
        if os.name == "nt":
            subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"], capture_output=True)
            continue
        try:
            os.killpg(pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass


def _run_shell(cmd: str, cwd: str, spawned: list[int] | None = None) -> tuple[str, bool]:
    posix = os.name != "nt"
    proc = subprocess.Popen(
        cmd, shell=True, cwd=cwd, env=_shell_env(), stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, encoding="utf-8", errors="replace", start_new_session=posix,
    )
    if spawned is not None:
        spawned.append(proc.pid)
    try:
        out, _ = proc.communicate(timeout=SHELL_TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired:
        if posix:
            try:
                os.killpg(proc.pid, signal.SIGKILL)  # the shell and anything it started, so the pipe closes
            except ProcessLookupError:
                pass
        else:
            subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], capture_output=True)
        out, _ = proc.communicate()
        return f"{_cut(out)}\n[command timed out after {SHELL_TIMEOUT_SECONDS} seconds and was killed]", True
    if proc.returncode != 0:
        return f"{_cut(out)}\n[exit code {proc.returncode}]", True
    return _cut(out), False


def _clean(text: str) -> str:
    """Model text can hold lone surrogates, which neither the trace file nor a JSON request body can carry."""
    return text.encode("utf-8", "replace").decode("utf-8")


def _run_file_tool(name: str, args: dict[str, str], workspace: Path) -> tuple[str, bool]:
    root = workspace.resolve()
    target = (root / args["path"]).resolve()  # an absolute path replaces root; symlinks are followed
    if target != root and root not in target.parents:
        return f"error: {args['path']!r} is outside the workspace", True
    try:
        if name == "read_file":
            with open(target, encoding="utf-8", errors="replace") as f:
                return _cut(f.read(4 * MAX_TOOL_OUTPUT_CHARS)), False
        if name == "write_file":
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(args["content"], encoding="utf-8", newline="")
            return f"wrote {len(args['content'])} characters to {args['path']}", False
        entries = sorted(p.name + ("/" if p.is_dir() else "") for p in target.iterdir())
        return "\n".join(entries), False
    except OSError as e:
        return f"error: {type(e).__name__}: {e.strerror or e}", True
