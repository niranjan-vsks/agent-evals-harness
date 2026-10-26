"""Child entry point: python -m worker.run_one <spec.json>  (R-1).

Runs prepare -> run -> collect_memory in this one process, then writes child/result.json (the run result,
the memory and the run time). It does not grade: the graders are not in its spec, and the runner grades as root
once the child is gone while the workspace still exists (R-7, R-11). A programming error propagates: the process
exits non-zero without result.json and the runner reports worker_crash (R-3, H-6).

The spec file is deleted as soon as it is read, before prepare() (R-10), and the trial dir is checked to hold
nothing but the runner's own directories. If either step fails the child exits non-zero rather than start an
agent next to a spec file.
"""
import dataclasses
import json
import os
import sys
import time
from pathlib import Path

from worker.adapters.base import TrialContext
from worker.registry import load_registry
from worker.spec import build_context, parse_trial_spec


def load_context(payload: dict) -> tuple[TrialContext, list[dict]]:
    """The trial context and the graders the payload carries (none, in the child's view of the spec)."""
    parsed = parse_trial_spec(payload["spec"])
    paths = payload["paths"]
    ctx = build_context(
        parsed,
        trial_dir=paths["trial_dir"],
        workspace_dir=paths["workspace_dir"],
        events_path=paths["events_path"],
        fixture_dir=paths["fixture_dir"],
    )
    return ctx, parsed.task.get("graders", [])


# What may exist under trial_dir when the agent starts: the runner's workspace, out, home, tmp (HOME and TMPDIR of the
# child, empty) and child (where its events and result go); prepare() then adds the harness's own home (hermes_home, memory). Anything else is a leak (R-10).
_RUNNER_DIRS = frozenset({"workspace", "out", "home", "tmp", "child"})


def consume_spec(spec_path: str) -> dict:
    """Read the spec and delete the file. Fails closed: a spec that cannot be deleted is not run."""
    path = Path(spec_path)
    payload = json.loads(path.read_text(encoding="utf-8"))
    path.unlink()
    return payload


def assert_trial_dir_holds_no_extras(trial_dir: str) -> None:
    extras = sorted(p.name for p in Path(trial_dir).iterdir() if p.name not in _RUNNER_DIRS)
    if extras:
        raise RuntimeError(f"refusing to start the agent: {trial_dir} holds {extras} besides {sorted(_RUNNER_DIRS)} (R-10)")


def main(spec_path: str) -> int:
    payload = consume_spec(spec_path)
    ctx, _ = load_context(payload)
    assert_trial_dir_holds_no_extras(ctx.trial_dir)
    adapter = load_registry()[payload["spec"]["harness"]]
    result_path = Path(payload["result_path"])

    adapter.prepare(ctx)
    started = time.monotonic()
    run_result = adapter.run(ctx)
    run_ms = int((time.monotonic() - started) * 1000)
    memory = adapter.collect_memory(ctx)

    result = {"run_result": dataclasses.asdict(run_result), "memory_final": memory.files, "run_ms": run_ms}
    tmp = result_path.with_name(result_path.name + ".tmp")
    tmp.write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, result_path)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
