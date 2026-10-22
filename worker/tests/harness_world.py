"""Shared by the conformance suite and the hermes-specific tests: a memoizing runner of trials
against the stub model server. Trial dirs are kept so tests can inspect them."""
import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from worker.runner import RunnerConfig, run_trial
from worker.tests.conftest import make_spec

SEED = {
    "MEMORY.md": "Staging DB is pg-stage-07.internal:6432\n§\nThe nightly cron runs in Europe/Amsterdam",
    "USER.md": "Name: Dana Okafor. Prefers terse answers.",
}
SEEDED = {"mode": "seeded", "fixture": "team-memory-v1", "fixture_hash": "f" * 64}


@dataclass
class Run:
    result: dict[str, Any]
    chat_requests: list[dict[str, Any]]
    trial_dir: Path
    spec: dict[str, Any]
    events: list[dict[str, Any]] = field(default_factory=list)

    def kinds(self, kind: str) -> list[dict[str, Any]]:
        return [e for e in self.events if e["kind"] == kind]


class World:
    def __init__(self, base: Path, tasks: Path, stub: Any):
        self.base, self.tasks, self.stub = base, tasks, stub
        self.cfg = RunnerConfig(
            work_dir=base / "work", tasks_dir=tasks, keep_trial_dirs=True, kill_margin_seconds=45.0, term_grace_seconds=2.0
        )
        self._cache: dict[tuple, Run] = {}

    def run(self, adapter: str, scenario: str, **kw: Any) -> Run:
        key = (adapter, scenario, json.dumps(kw, sort_keys=True, default=str))
        if key in self._cache:
            return self._cache[key]
        memory = kw.pop("memory", None)
        spec = make_spec(
            self.tasks,
            harness=adapter,
            base_url=self.stub.base_url,
            slug=f"stub/{scenario}",
            memory=memory,
            memory_seed=SEED if memory else None,
            **kw,
        )
        before = len(self.stub.requests)
        result = run_trial(spec, self.cfg)
        requests = [r for r in self.stub.requests[before:] if r["path"].rstrip("/").endswith("/chat/completions")]
        trace = result.get("trace")
        events = trace["events"] if trace else (result.get("partial_trace") or [])
        self._cache[key] = Run(result, requests, self.cfg.work_dir / "trials" / spec["trial_id"] / "1", spec, events)
        return self._cache[key]
