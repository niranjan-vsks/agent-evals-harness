"""A scriptable adapter for runner tests. harness_options["mode"] picks the behaviour."""
import os
import time
from pathlib import Path

from worker.adapters.base import (
    Capabilities,
    HarnessRunResult,
    MemorySnapshot,
    Settings,
    TrialContext,
    Usage,
)
from worker.trace import TraceWriter, write_events_fresh

COUNTER = 0  # module state: a fresh child process must see 0 every time (R-1)


class FakeAdapter:
    id = "fake"
    version = "0.0.1"
    capabilities = Capabilities(
        tools=frozenset({"shell", "files"}),
        memory_modes=frozenset({"off", "seeded"}),
        memory_writes=False,
        skills=False,
        temperature=True,
        seed=True,
        system_prompt_capture=True,
    )

    def validate(self, settings: Settings) -> list[str]:
        return ["fake adapter was told to reject"] if settings.harness_options.get("reject") else []

    def prepare(self, ctx: TrialContext) -> None:
        write_events_fresh(ctx.events_path, [])

    def run(self, ctx: TrialContext) -> HarnessRunResult:
        global COUNTER
        COUNTER += 1
        mode = ctx.settings.harness_options.get("mode", "ok")
        w = TraceWriter(ctx.events_path)
        notes: list[str] = []
        final = "FINAL: 8081"
        ws = Path(ctx.workspace_dir)

        w.emit("message", role="system", content="fake system prompt", step=0)
        w.emit("message", role="user", content=ctx.task.prompt, step=0)
        w.emit("api_call", step=1, model=ctx.model.slug, input_tokens=10, output_tokens=5, latency_ms=3, status="ok", http_status=200)

        if mode == "stall":
            w.emit("api_call", step=2, model=ctx.model.slug, input_tokens=12, output_tokens=6, latency_ms=3, status="ok", http_status=200)
            w.emit("tool_call", call_id="c1", step=2, tool="shell", harness_tool="fake_shell", args={"cmd": "echo hi"})
            w.emit("pid", pid=os.getpid())
            time.sleep(3600)
        elif mode == "crash":
            os._exit(3)
        elif mode == "raise":
            raise RuntimeError("fake programming error")
        elif mode == "counter":
            final = f"count={COUNTER}"
        elif mode == "env":
            final = ",".join(sorted(k for k in os.environ if k.endswith("_KEY") or k.startswith("OTHER_")))
        elif mode == "paths":
            final = "|".join([os.environ.get("HOME", ""), os.environ.get("TMPDIR", ""), os.environ.get("HERMES_HOME", "")])
        elif mode == "write_workspace":
            for p in ws.rglob("*"):
                if p.is_file():
                    final += f"|link={p.is_symlink()}"
                    p.write_text("MUTATED BY AGENT", encoding="utf-8")
            (ws / "answer.txt").write_text("42\n", encoding="utf-8")
        elif mode == "list_trial_dir":  # R-10: what sits next to the workspace while the agent runs
            trial = Path(ctx.trial_dir)
            final = "FINAL: " + ",".join(sorted(p.name for p in trial.iterdir())) + "|" + ",".join(sorted(p.name for p in trial.rglob("*.json")))
        elif mode == "list_workspace":
            final = "FINAL: " + ",".join(sorted(p.relative_to(ws).as_posix() for p in ws.rglob("*")))
        elif mode.startswith("provider_") and mode[9:].isdigit():
            status = int(mode[9:])  # provider_429, provider_502, provider_401, provider_400 ...
            w.emit("api_call", step=2, model=ctx.model.slug, input_tokens=0, output_tokens=0, latency_ms=2, status="error", http_status=status)
            w.emit("error", stage="run", message=f"provider answered {status}", retryable=status == 429 or status >= 500, http_status=status)
            return self._result(None, "agent_error", 1, [f"provider {status}"])
        elif mode == "error_without_status":
            w.emit("api_call", step=2, model=ctx.model.slug, input_tokens=0, output_tokens=0, latency_ms=2, status="error", http_status=None)
            w.emit("error", stage="run", message="connection dropped", retryable=True, http_status=None)
            return self._result(None, "agent_error", 1, ["no status"])
        elif mode == "old_style_retryable_error":
            # What an adapter written before DESIGN 11 entry 17 emits: retryable=true and a 429 on the api_call, but no http_status on the error.
            w.emit("api_call", step=2, model=ctx.model.slug, input_tokens=0, output_tokens=0, latency_ms=2, status="error", http_status=429)
            w.emit("error", stage="run", message="rate limited by provider", retryable=True)
            return self._result(None, "agent_error", 1, ["old style"])
        elif mode == "agent_error":
            w.emit("error", stage="run", message="model produced garbage", retryable=False)
            return self._result(None, "agent_error", 1, [])
        elif mode == "big_event":
            w.emit("tool_result", call_id="c1", output="x" * 25_000, is_error=False, duration_ms=1)
        elif mode == "secret_in_output":
            final = "FINAL: " + os.environ.get(ctx.model.api_key_env, "")
            notes.append("key=" + os.environ.get(ctx.model.api_key_env, ""))

        w.emit("message", role="assistant", content=final, step=1)
        w.close()
        return self._result(final, "completed", 1, notes)

    def _result(self, final: str | None, reason: str, steps: int, notes: list[str]) -> HarnessRunResult:
        return HarnessRunResult(
            final_response=final,
            exit_reason=reason,  # type: ignore[arg-type]
            steps=steps,
            usage=Usage(input_tokens=10, output_tokens=5, cache_read_tokens=None, reasoning_tokens=None, api_calls=steps),
            harness_reported_cost_usd=None,
            system_prompt="fake system prompt",
            skills_invoked=(),
            notes=tuple(notes),
        )

    def collect_memory(self, ctx: TrialContext) -> MemorySnapshot:
        # Marker for the R-7 ordering test: the file_state grader sees it only if grading ran after this.
        ws = Path(ctx.workspace_dir)
        if ws.is_dir():
            (ws / "collected.txt").write_text("collected\n", encoding="utf-8")
        return MemorySnapshot(files={})
