"""Subprocess runner: timeouts, kill, trace assembly (ADAPTERS 6, R-1 to R-8).

R-9 (WORKER_MAX_PARALLEL): run_trial admits at most that many attempts at once and raises WorkerBusy
beyond it, which the server turns into HTTP 429 (the API treats that as backpressure). Each running
child is also registered in worker.active_trials so DELETE /trials/{id} can cancel it.

Each attempt runs `python -m worker.run_one <spec>` as a fresh child process (R-1). The child
streams events to out/events.jsonl and, if it gets as far as grading, writes out/result.json.
The runner owns time (R-2) and builds the TrialResult from what is on disk (R-4).
"""
import json
import os
import shutil
import signal
import subprocess
import sys
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from worker import active_trials
from worker.adapters.base import TrialContext
from worker.graders import failed_for_timeout
from worker.graders.file_state import HIDDEN_DIR
from worker.registry import load_registry
from worker.spec import ParsedSpec, SpecError, build_context, parse_trial_spec
from worker.task_hash import task_hash
from worker.trace import read_events

# Env vars the child inherits, besides what the runner sets itself. Everything else, including
# every provider key not named in the spec, stays behind (R-1).
_PASSTHROUGH = (
    "PATH", "SYSTEMROOT", "SystemRoot", "COMSPEC", "PATHEXT", "WINDIR", "LANG", "LC_ALL",
    "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
    "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE", "WORKER_REGISTRY",
)


def _int_env(name: str, default: int) -> int:
    """An integer from the environment; a blank or non-numeric value (a compose pass-through of an unset
    variable gives "") means the default, so a typo cannot turn every request into an HTTP 500."""
    try:
        return int(os.environ.get(name, "").strip())
    except ValueError:
        return default


@dataclass(frozen=True)
class RunnerConfig:
    work_dir: Path
    tasks_dir: Path
    keep_trial_dirs: bool = False
    kill_margin_seconds: float = 60.0   # R-2: kill at timeout_seconds + 60
    term_grace_seconds: float = 10.0    # R-2: SIGKILL after a SIGTERM grace of 10 s
    max_parallel: int = 4               # R-9: attempts admitted at once; the next one gets HTTP 429
    python: str = field(default_factory=lambda: sys.executable)

    @staticmethod
    def from_env() -> "RunnerConfig":
        return RunnerConfig(
            work_dir=Path(os.environ.get("WORK_DIR", "/work")),
            tasks_dir=Path(os.environ.get("TASKS_DIR", "/tasks")),
            keep_trial_dirs=os.environ.get("KEEP_TRIAL_DIRS", "0") == "1",
            kill_margin_seconds=float(os.environ.get("RUNNER_KILL_MARGIN_SECONDS", "60")),
            term_grace_seconds=float(os.environ.get("RUNNER_TERM_GRACE_SECONDS", "10")),
            max_parallel=max(1, _int_env("WORKER_MAX_PARALLEL", 4)),
        )


def _scrub(text: str, secrets: list[str]) -> str:
    for s in secrets:
        if s:
            text = text.replace(s, "[REDACTED]")
    return text.replace("\x00", "")  # PostgreSQL jsonb cannot store NUL; tool output and judged files can contain it


def _scrub_deep(value: Any, secrets: list[str]) -> Any:
    """M-4 as a last line of defence: the key value cannot leave the runner in any string."""
    if isinstance(value, str):
        return _scrub(value, secrets)
    if isinstance(value, list):
        return [_scrub_deep(v, secrets) for v in value]
    if isinstance(value, dict):
        return {k: _scrub_deep(v, secrets) for k, v in value.items()}
    return value


def _kill_tree(proc: subprocess.Popen, grace: float) -> None:
    """SIGTERM, wait out the grace period, then SIGKILL, on the child's whole process group."""
    if os.name == "nt":
        subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], capture_output=True)
        try:
            proc.wait(timeout=grace)
        except subprocess.TimeoutExpired:
            proc.kill()
        return
    try:
        os.killpg(proc.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        proc.wait(timeout=grace)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        proc.wait()


def _reap_stragglers(proc: subprocess.Popen) -> None:
    """The child exited, but a background command it started may not have."""
    if os.name == "nt":
        subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], capture_output=True)
        return
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass


def _child_env(cfg: RunnerConfig, parsed: ParsedSpec, trial_dir: Path) -> dict[str, str]:
    home = trial_dir / "home"
    tmp = trial_dir / "tmp"
    env = {k: os.environ[k] for k in _PASSTHROUGH if k in os.environ}
    env.update(
        HOME=str(home),
        USERPROFILE=str(home),
        APPDATA=str(home / "AppData" / "Roaming"),
        LOCALAPPDATA=str(home / "AppData" / "Local"),
        TMPDIR=str(tmp),
        TEMP=str(tmp),
        TMP=str(tmp),
        HERMES_HOME=str(trial_dir / "hermes_home"),
        PYTHONPATH=str(Path(__file__).resolve().parent.parent),
        PYTHONUTF8="1",
        PYTHONIOENCODING="utf-8",
    )
    for model in (parsed.model, parsed.judge_model):
        if model is not None and model.api_key_env in os.environ:
            env[model.api_key_env] = os.environ[model.api_key_env]
    return env


def _spec_path(cfg: RunnerConfig, parsed: ParsedSpec) -> Path:
    """Where the child's spec file lives: outside every trial dir (R-10)."""
    return cfg.work_dir / "specs" / f"{parsed.trial_id}-{parsed.attempt}.json"


def _copy_fixture(src: Path, dst: Path) -> None:
    """R-5: copy, never symlink. Content only, so permissions of a read-only mount are not
    inherited. The _hidden/ subtree (grader-only files) is not copied (R-7)."""
    for p in sorted(src.rglob("*")):
        rel = p.relative_to(src)
        if rel.parts and rel.parts[0] == HIDDEN_DIR:
            continue
        target = dst / rel
        if p.is_dir():
            target.mkdir(parents=True, exist_ok=True)
        elif p.is_file():
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(p, target)


def _remove_tree(path: Path) -> None:
    for attempt in range(5):
        try:
            shutil.rmtree(path)
            return
        except FileNotFoundError:
            return
        except OSError:
            time.sleep(0.2 * (attempt + 1))
    shutil.rmtree(path, ignore_errors=True)


def _error_result(spec: dict[str, Any], error_class: str, message: str, *, partial_trace: list | None = None) -> dict[str, Any]:
    return {
        "trial_id": spec.get("trial_id"),
        "attempt": spec.get("attempt"),
        "status": "errored",
        "harness": None,
        "outcome": None,
        "passed": None,
        "trace": None,
        "grader_results": [],
        "error_class": error_class,
        "error_message": message,
        "partial_trace": partial_trace,
    }


def _usage_from_events(events: list[dict[str, Any]]) -> dict[str, Any]:
    ok = [e for e in events if e.get("kind") == "api_call" and e.get("status") == "ok"]
    return {
        "input_tokens": sum(int(e.get("input_tokens") or 0) for e in ok),
        "output_tokens": sum(int(e.get("output_tokens") or 0) for e in ok),
        "cache_read_tokens": None,
        "reasoning_tokens": None,
        "api_calls": len(ok),
    }


def classify_http_status(status: Any) -> str | None:
    """DESIGN 6.3: 429 is rate_limited, any other 4xx is config_invalid, 5xx is provider_error. A trial
    with no HTTP status to go by (None, or anything that is not an integer) has no class: it is scored."""
    if isinstance(status, bool) or not isinstance(status, int):
        return None
    if status == 429:
        return "rate_limited"
    if 400 <= status < 500:
        return "config_invalid"
    if 500 <= status < 600:
        return "provider_error"
    return None


def _provider_failure(events: list[dict[str, Any]]) -> tuple[str, str] | None:
    """A trial that ended because the provider answered with an HTTP error is infra, not a scored
    failure (DESIGN 6.3, DESIGN 11 entry 17). The adapter says so with its last `error` event: an
    integer `http_status` is the evidence, and the class follows from it. An `error` event without one
    (the harness crashed, the connection dropped, nothing came back) leaves the trial a scored
    agent_error. The `retryable` field is informational and is not read here."""
    errors = [e for e in events if e.get("kind") == "error" and e.get("stage") == "run"]
    if not errors:
        return None
    last = errors[-1]
    klass = classify_http_status(last.get("http_status"))
    if klass is None:
        return None
    return klass, str(last.get("message", ""))


def _first_system_prompt(events: list[dict[str, Any]]) -> str | None:
    for e in events:
        if e.get("kind") == "message" and e.get("role") == "system":
            return e.get("content")
    return None


def _build_context(parsed: ParsedSpec, trial_dir: Path, fixture_abs: Path | None) -> TrialContext:
    return build_context(
        parsed,
        trial_dir=str(trial_dir),
        workspace_dir=str(trial_dir / "workspace"),
        events_path=str(trial_dir / "out" / "events.jsonl"),
        fixture_dir=str(fixture_abs) if fixture_abs else None,
    )


class WorkerBusy(Exception):
    """R-9: the worker already runs WORKER_MAX_PARALLEL attempts. The server answers HTTP 429."""


_admission = threading.Lock()
_in_flight = 0


def _admit(limit: int) -> None:
    global _in_flight
    with _admission:
        if _in_flight >= limit:
            raise WorkerBusy(f"worker at capacity ({_in_flight} of {limit} attempts running, WORKER_MAX_PARALLEL)")
        _in_flight += 1


def _release() -> None:
    global _in_flight
    with _admission:
        _in_flight -= 1


def run_trial(spec: dict[str, Any], cfg: RunnerConfig | None = None) -> dict[str, Any]:
    """Runs 1 attempt and returns a TrialResult dict. Never raises for a bad spec or a bad child.

    Raises WorkerBusy (R-9) before doing any work when the worker is at capacity.
    """
    cfg = cfg or RunnerConfig.from_env()
    _admit(cfg.max_parallel)
    try:
        return _run_admitted(spec, cfg)
    finally:
        _release()


def _run_admitted(spec: dict[str, Any], cfg: RunnerConfig) -> dict[str, Any]:
    try:
        parsed = parse_trial_spec(spec)
    except SpecError as e:
        return _error_result(spec if isinstance(spec, dict) else {}, "config_invalid", f"invalid TrialSpec: {e}")

    registry = load_registry()
    adapter = registry.get(parsed.harness)
    if adapter is None:
        return _error_result(spec, "config_invalid", f"unknown harness {parsed.harness!r}")

    if active_trials.is_running(parsed.trial_id):
        # A lost call re-dispatched while the first child still runs. Refuse before touching the disk (the
        # directory of the same attempt belongs to that child); 429 so the API re-queues without an attempt.
        raise WorkerBusy(f"trial {parsed.trial_id!r} is already running on this worker")

    if active_trials.consume_tombstone(parsed.trial_id):
        # DELETE /trials/{id} arrived before this child existed: nothing to kill, nothing to run.
        return _error_result(spec, "cancelled", "cancelled by DELETE /trials/{id} before the child started")

    secrets: list[str] = []
    for model in (parsed.model, parsed.judge_model):
        if model is None:
            continue
        if model.api_key_env not in os.environ:
            # Not retryable: retrying a worker that was started without the key cannot help.
            return _error_result(spec, "config_invalid", f"the worker has no environment variable {model.api_key_env} (the api_key_env of model {model.id})")
        secrets.append(os.environ[model.api_key_env])
    task_id = parsed.task["id"]

    # R-6: the task on disk must be the task the experiment pinned.
    task_file = cfg.tasks_dir / f"{task_id}.json"
    if not task_file.is_file():
        return _error_result(spec, "config_invalid", f"task file {task_id}.json not found")
    task_json = json.loads(task_file.read_text(encoding="utf-8"))
    fixture_rel = task_json.get("fixture_dir")
    fixture_abs = (cfg.tasks_dir / fixture_rel) if fixture_rel else None
    on_disk = task_hash(task_json, fixture_abs)
    if on_disk != parsed.task["version_hash"]:
        return _error_result(
            spec,
            "config_invalid",
            f"task {task_id} changed on disk: pinned {parsed.task['version_hash'][:12]}, found {on_disk[:12]}",
        )

    trial_dir = cfg.work_dir / "trials" / parsed.trial_id / str(parsed.attempt)
    if trial_dir.exists():
        _remove_tree(trial_dir)
    try:
        return _scrub_deep(_run_in_dir(spec, parsed, adapter, cfg, trial_dir, fixture_abs, secrets), secrets)
    finally:
        _spec_path(cfg, parsed).unlink(missing_ok=True)  # normally the child already deleted it; a child that never started did not
        if not cfg.keep_trial_dirs:  # R-8
            _remove_tree(trial_dir)
            try:
                trial_dir.parent.rmdir()
            except OSError:
                pass


def _run_in_dir(spec, parsed: ParsedSpec, adapter, cfg: RunnerConfig, trial_dir: Path, fixture_abs: Path | None, secrets: list[str]) -> dict[str, Any]:
    for sub in ("workspace", "out", "home", "tmp"):
        (trial_dir / sub).mkdir(parents=True, exist_ok=True)
    if fixture_abs is not None:
        _copy_fixture(fixture_abs, trial_dir / "workspace")  # R-5

    ctx = _build_context(parsed, trial_dir, fixture_abs)
    # The spec holds the graders (expected answers, hidden-test names, regexes), so it never lives under trial_dir, where the
    # agent's shell starts: it is written next to the trial dirs and the child deletes it as soon as it has read it (R-10).
    spec_path = _spec_path(cfg, parsed)
    spec_path.parent.mkdir(parents=True, exist_ok=True)
    spec_path.write_text(
        json.dumps({"spec": spec, "paths": {"trial_dir": ctx.trial_dir, "workspace_dir": ctx.workspace_dir, "events_path": ctx.events_path, "fixture_dir": ctx.task.fixture_dir}}),
        encoding="utf-8",
    )

    out_dir = trial_dir / "out"
    started = time.monotonic()
    timed_out = False
    cancelled = False
    with open(out_dir / "child.stdout.log", "wb") as so, open(out_dir / "child.stderr.log", "wb") as se:
        popen_kwargs: dict[str, Any] = {}
        if os.name == "nt":
            popen_kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
        else:
            popen_kwargs["start_new_session"] = True
        proc = subprocess.Popen(
            [cfg.python, "-m", "worker.run_one", str(spec_path)],
            cwd=str(trial_dir),
            env=_child_env(cfg, parsed, trial_dir),
            stdout=so,
            stderr=se,
            **popen_kwargs,
        )
        try:
            active_trials.register(parsed.trial_id, proc)  # DELETE /trials/{id} finds the child here
        except ValueError as e:
            # The same trial id is still running here (a lost call re-dispatched). Two children would share a
            # registry slot, so the newcomer yields and the scheduler retries once the first one is gone.
            _kill_tree(proc, cfg.term_grace_seconds)
            return _error_result(spec, "worker_crash", str(e))
        try:
            if active_trials.consume_tombstone(parsed.trial_id):
                active_trials.cancel(parsed.trial_id)  # the DELETE landed between the check above and register
            try:
                proc.wait(timeout=parsed.settings.timeout_seconds + cfg.kill_margin_seconds)  # R-2
            except subprocess.TimeoutExpired:
                timed_out = True
                _kill_tree(proc, cfg.term_grace_seconds)
            else:
                _reap_stragglers(proc)
            cancelled = active_trials.was_signalled(parsed.trial_id, proc)
        finally:
            active_trials.unregister(parsed.trial_id, proc)
    wall_ms = int((time.monotonic() - started) * 1000)

    events = read_events(ctx.events_path)  # R-4: from disk, never from the child's memory
    result_path = out_dir / "result.json"
    harness_info = {"id": adapter.id, "version": adapter.version}

    if result_path.is_file():
        child = json.loads(result_path.read_text(encoding="utf-8"))
        if "grader_error" in child:
            return _error_result(spec, "grader_error", _scrub(child["grader_error"], secrets), partial_trace=events)
        run = child["run_result"]
        graders = child["grader_results"]
        if run["exit_reason"] == "agent_error":
            failure = _provider_failure(events)
            if failure is not None:
                return _error_result(spec, failure[0], _scrub(failure[1], secrets), partial_trace=events)
        return {
            "trial_id": parsed.trial_id,
            "attempt": parsed.attempt,
            "status": "done",
            "harness": harness_info,
            "outcome": {
                "exit_reason": run["exit_reason"],
                "final_response": run["final_response"],
                "steps": run["steps"],
                "usage": run["usage"],
                "harness_reported_cost_usd": run["harness_reported_cost_usd"],
                "latency_ms": child["run_ms"],
            },
            "passed": all(g["passed"] for g in graders) and run["exit_reason"] != "timeout",
            "trace": {
                "events": events,
                "system_prompt": run["system_prompt"],
                "memory_initial": parsed.memory_seed or {},
                "memory_final": child["memory_final"],
                "skills_invoked": run["skills_invoked"],
                "notes": [_scrub(n, secrets) for n in run["notes"]],
                "final_response": run["final_response"],
            },
            "grader_results": graders,
            "error_class": None,
            "error_message": None,
            "partial_trace": None,
        }

    if cancelled and not timed_out:
        # DELETE /trials/{id} killed the child before it wrote a result: not an agent outcome, not plumbing.
        return _error_result(spec, "cancelled", "cancelled by DELETE /trials/{id}", partial_trace=events)

    if timed_out:
        # collect_memory reads only from disk (H-8), so the parent can call it after a kill.
        try:
            memory_final = adapter.collect_memory(ctx).files
        except Exception:  # noqa: BLE001 - best effort; the trial is still scored
            memory_final = {}
        usage = _usage_from_events(events)
        graders = [g.to_dict() for g in failed_for_timeout(parsed.task.get("graders", []), parsed.judge_model)]
        return {
            "trial_id": parsed.trial_id,
            "attempt": parsed.attempt,
            "status": "done",
            "harness": harness_info,
            "outcome": {
                "exit_reason": "timeout",
                "final_response": None,
                "steps": usage["api_calls"],
                "usage": usage,
                "harness_reported_cost_usd": None,
                "latency_ms": wall_ms,
            },
            "passed": False,
            "trace": {
                "events": events,
                "system_prompt": _first_system_prompt(events),
                "memory_initial": parsed.memory_seed or {},
                "memory_final": memory_final,
                "skills_invoked": [],
                "notes": [f"killed by the runner after {wall_ms} ms (timeout_seconds {parsed.settings.timeout_seconds} + margin)"],
                "final_response": None,
            },
            "grader_results": graders,
            "error_class": None,
            "error_message": None,
            "partial_trace": None,
        }

    # R-3: no result and no timeout kill means our plumbing failed, not the agent.
    stderr_tail = ""
    try:
        stderr_tail = (out_dir / "child.stderr.log").read_text(encoding="utf-8", errors="replace")[-2000:]
    except OSError:
        pass
    return _error_result(
        spec,
        "worker_crash",
        _scrub(f"child exited with code {proc.returncode} without writing result.json. stderr tail: {stderr_tail}", secrets),
        partial_trace=events,
    )
