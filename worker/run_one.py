"""Child entry point: python -m worker.run_one <spec.json>  (R-1).

Runs prepare -> run -> collect_memory -> graders in this one process while the workspace still
exists (R-7), then writes out/result.json. A programming error propagates: the process exits
non-zero without result.json and the runner reports worker_crash (R-3, H-6).

The spec file holds the graders, so it is deleted as soon as it is read, before prepare() (R-10), and the
trial dir is checked to hold nothing but the runner's own directories. If either step fails the child exits
non-zero rather than start an agent next to the graders.
"""
import dataclasses
import json
import os
import sys
import time
from pathlib import Path

from worker.adapters.base import TrialContext
from worker.graders import GraderError, run_graders
from worker.registry import load_registry
from worker.spec import build_context, parse_trial_spec


def load_context(payload: dict) -> tuple[TrialContext, list[dict]]:
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


def load_judge_model(payload: dict):
    return parse_trial_spec(payload["spec"]).judge_model


# What may exist under trial_dir when the agent starts: the runner's workspace, out, home and tmp (HOME and TMPDIR of the
# child, empty); prepare() then adds the harness's own home (hermes_home, memory). Anything else is a leak (R-10).
_RUNNER_DIRS = frozenset({"workspace", "out", "home", "tmp"})


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
    ctx, graders = load_context(payload)
    assert_trial_dir_holds_no_extras(ctx.trial_dir)
    adapter = load_registry()[payload["spec"]["harness"]]
    out_dir = Path(ctx.trial_dir) / "out"

    adapter.prepare(ctx)
    started = time.monotonic()
    run_result = adapter.run(ctx)
    run_ms = int((time.monotonic() - started) * 1000)
    memory = adapter.collect_memory(ctx)

    result: dict = {
        "run_result": dataclasses.asdict(run_result),
        "memory_final": memory.files,
        "run_ms": run_ms,
    }
    try:
        result["grader_results"] = [g.to_dict() for g in run_graders(graders, ctx, run_result, load_judge_model(payload))]
    except GraderError as e:
        result["grader_error"] = str(e)

    tmp = out_dir / "result.json.tmp"
    tmp.write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, out_dir / "result.json")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
