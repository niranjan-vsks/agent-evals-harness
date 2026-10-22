"""Adapter conformance suite (ADAPTERS 7): parametrized over every entry in REGISTRY, run against
the scripted stub model server. A new adapter is done when this is green for it.

Asserts H-1 to H-11, M-1, M-3 and M-4. Trials run through the real runner, so each one is a
fresh child process; runs are memoized per scenario because a Hermes start is slow on a laptop.
"""
import hashlib
import json
import os
import re
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import pytest

from worker.adapters import REGISTRY
from worker.adapters.base import MemorySettings, Settings, SkillSettings
from worker.spec import build_context, parse_trial_spec
from worker.tests.conftest import SENTINEL_KEY, make_spec
from worker.tests.harness_world import SEED, SEEDED

ADAPTERS_DIR = Path(__file__).resolve().parent.parent / "adapters"


@pytest.fixture(scope="module", params=sorted(REGISTRY))
def adapter_id(request) -> str:
    return request.param


def settings(**over: Any) -> Settings:
    base = dict(
        tools=("shell", "files"),
        memory=MemorySettings("off", None, None),
        skills=SkillSettings(False, ()),
        temperature=0.0,
        max_steps=15,
        max_output_tokens=2048,
        timeout_seconds=300,
        harness_options={},
    )
    base.update(over)
    return Settings(**base)


# ------------------------------------------------------------------ H-1


class TestH1ValidateRejectsWhatItCannotHonor:
    def test_a_valid_configuration_is_accepted(self, adapter_id):
        assert REGISTRY[adapter_id].validate(settings()) == []

    def test_every_capability_gap_is_rejected(self, adapter_id):
        adapter = REGISTRY[adapter_id]
        caps = adapter.capabilities
        for tool in {"shell", "files", "browser"} - set(caps.tools):
            assert adapter.validate(settings(tools=(tool,))), f"tool {tool} is outside capabilities"
        if not caps.skills:
            assert adapter.validate(settings(skills=SkillSettings(True, ())))
        for mode in {"off", "seeded"} - set(caps.memory_modes):
            assert adapter.validate(settings(memory=MemorySettings(mode, "x", "y")))

    def test_unknown_harness_options_are_never_silently_ignored(self, adapter_id):
        assert REGISTRY[adapter_id].validate(settings(harness_options={"turbo": True}))

    def test_seeded_memory_needs_a_fixture_that_exists_on_the_worker(self, adapter_id, monkeypatch, tmp_path):
        adapter = REGISTRY[adapter_id]
        monkeypatch.setenv("TASKS_DIR", str(tmp_path))
        assert adapter.validate(settings(memory=MemorySettings("seeded", None, None)))
        assert adapter.validate(settings(memory=MemorySettings("seeded", "nope", "h")))

    def test_a_memory_fixture_over_the_harness_limit_is_rejected(self, adapter_id, monkeypatch, tmp_path):
        if adapter_id != "hermes":
            pytest.skip("character limits are a hermes property")
        fx = tmp_path / "memory" / "big"
        fx.mkdir(parents=True)
        (fx / "MEMORY.md").write_text("x" * 2201, encoding="utf-8")
        (fx / "USER.md").write_text("y" * 1376, encoding="utf-8")
        monkeypatch.setenv("TASKS_DIR", str(tmp_path))
        reasons = REGISTRY[adapter_id].validate(settings(memory=MemorySettings("seeded", "big", "h")))
        assert any("MEMORY.md" in r and "2200" in r for r in reasons)
        assert any("USER.md" in r and "1375" in r for r in reasons)

    def test_limits_are_inclusive(self, adapter_id, monkeypatch, tmp_path):
        if adapter_id != "hermes":
            pytest.skip("character limits are a hermes property")
        fx = tmp_path / "memory" / "edge"
        fx.mkdir(parents=True)
        (fx / "MEMORY.md").write_text("x" * 2200, encoding="utf-8")
        (fx / "USER.md").write_text("y" * 1375, encoding="utf-8")
        monkeypatch.setenv("TASKS_DIR", str(tmp_path))
        assert REGISTRY[adapter_id].validate(settings(memory=MemorySettings("seeded", "edge", "h"))) == []

    def test_degenerate_numbers_are_rejected(self, adapter_id):
        adapter = REGISTRY[adapter_id]
        assert adapter.validate(settings(max_steps=0))
        assert adapter.validate(settings(timeout_seconds=0))
        assert adapter.validate(settings(tools=()))


# ------------------------------------------------------------------ H-2


def _tree(root: Path) -> dict[str, float]:
    if not root.exists():
        return {}
    out = {}
    for p in root.rglob("*"):
        try:
            out[str(p)] = p.stat().st_mtime
        except OSError:
            pass
    return out


def test_h2_nothing_is_written_outside_the_trial_dir(adapter_id, world):
    default_homes = [Path.home() / ".hermes"]
    local = os.environ.get("LOCALAPPDATA")
    if local:
        default_homes.append(Path(local) / "hermes")
    before = [_tree(h) for h in default_homes]
    run = world.run(adapter_id, "shell_then_answer", timeout=120)
    assert run.result["status"] == "done"
    assert [_tree(h) for h in default_homes] == before, "the harness's default home was touched"
    # What the harness did write is under the trial dir: home, tmp and the harness's own directories.
    written = {p.relative_to(run.trial_dir).parts[0] for p in run.trial_dir.iterdir()}
    assert {"workspace", "out"} <= written


# ------------------------------------------------------------------ H-3


class TestH3MemoryIsTheOnlyAxis:
    def test_off_means_no_memory_content_tool_or_event(self, adapter_id, world):
        run = world.run(adapter_id, "echo_memory", timeout=120)
        r = run.result
        assert r["status"] == "done"
        assert r["outcome"]["final_response"] == "FINAL: unknown"
        assert not run.kinds("memory_read")
        assert "pg-stage-07" not in (r["trace"]["system_prompt"] or "")
        assert r["trace"]["memory_initial"] == {}
        assert r["trace"]["memory_final"] == {}
        offered = {t["function"]["name"] for t in run.chat_requests[0]["body"]["tools"]}
        assert "memory" not in offered

    def test_seeded_means_exactly_the_seed(self, adapter_id, world):
        run = world.run(adapter_id, "echo_memory", timeout=120, memory=SEEDED)
        r = run.result
        assert r["status"] == "done"
        assert r["outcome"]["final_response"] == "FINAL: pg-stage-07.internal:6432"
        prompt = r["trace"]["system_prompt"]
        for text in (SEED["MEMORY.md"].split("\n§\n") + SEED["USER.md"].split("\n§\n")):
            assert text in prompt
        assert {e["file"] for e in run.kinds("memory_read")} == {"MEMORY.md", "USER.md"}
        assert r["trace"]["memory_initial"] == SEED
        assert r["trace"]["memory_final"] == SEED

    def test_the_captured_system_prompt_is_what_was_sent_on_the_first_call(self, adapter_id, world):
        run = world.run(adapter_id, "echo_memory", timeout=120, memory=SEEDED)
        sent = run.chat_requests[0]["body"]["messages"][0]
        assert sent["role"] == "system"
        assert run.result["trace"]["system_prompt"] == sent["content"]


# ------------------------------------------------------------------ H-4


@pytest.mark.parametrize("only", ["shell", "files"])
def test_h4_tools_outside_the_configured_set_are_never_offered_or_called(adapter_id, world, only):
    run = world.run(adapter_id, "all_tools", timeout=120, tools=(only,))
    assert run.result["status"] == "done"
    called = {e["tool"] for e in run.kinds("tool_call")}
    assert called == {only}
    other = ({"shell", "files"} - {only}).pop()
    assert other not in called


def test_h4_hermes_offers_exactly_the_toolsets_it_was_given(world):
    if "hermes" not in REGISTRY:
        pytest.skip("hermes only")
    run = world.run("hermes", "all_tools", timeout=120, tools=("shell",))
    offered = {t["function"]["name"] for t in run.chat_requests[0]["body"]["tools"]}
    assert offered == {"terminal", "process_manage"}


# ------------------------------------------------------------------ H-5


def _digest_tree(root: Path) -> str:
    h = hashlib.sha256()
    for p in sorted(root.rglob("*")):
        if p.is_file():
            h.update(p.relative_to(root).as_posix().encode() + b"\0" + p.read_bytes())
    return h.hexdigest()


def test_h5_prepare_is_deterministic_and_idempotent(adapter_id, world, tmp_path):
    spec = make_spec(world.tasks, harness=adapter_id, memory=SEEDED, memory_seed=SEED)
    parsed = parse_trial_spec(spec)
    trial_dir = tmp_path / "trial"
    for sub in ("workspace", "out"):
        (trial_dir / sub).mkdir(parents=True)
    ctx = build_context(
        parsed,
        trial_dir=str(trial_dir),
        workspace_dir=str(trial_dir / "workspace"),
        events_path=str(trial_dir / "out" / "events.jsonl"),
        fixture_dir=None,
    )
    adapter = REGISTRY[adapter_id]
    adapter.prepare(ctx)
    first = _digest_tree(trial_dir)
    adapter.prepare(ctx)
    assert _digest_tree(trial_dir) == first


# ------------------------------------------------------------------ H-6


def test_h6_malformed_tool_calls_are_a_scored_outcome_not_an_exception(adapter_id, world):
    run = world.run(adapter_id, "malformed_tool", timeout=120)
    r = run.result
    assert r["status"] == "done", r.get("error_message")
    assert r["outcome"]["exit_reason"] in ("invalid_tool_call", "agent_error")
    assert r["passed"] is False


# ------------------------------------------------------------------ H-7


def test_h7_events_survive_a_kill(adapter_id, world):
    """The stub answers calls 1 and 2 with tool calls and never answers call 3; the runner kills
    the child. Both completed calls must be in the trace."""
    run = world.run(adapter_id, "stall_on_3", timeout=5)
    r = run.result
    assert r["outcome"]["exit_reason"] == "timeout"
    assert r["passed"] is False
    ok_calls = [e for e in run.events if e["kind"] == "api_call" and e["status"] == "ok"]
    assert len(ok_calls) >= 2
    assert len(run.kinds("tool_call")) >= 2 and len(run.kinds("tool_result")) >= 2


# ------------------------------------------------------------------ H-8


def test_h8_collect_memory_reads_only_from_disk_in_a_fresh_process(adapter_id, world):
    run = world.run(adapter_id, "echo_memory", timeout=120, memory=SEEDED)
    code = (
        "import json, sys\n"
        "from worker.run_one import load_context\n"
        "from worker.registry import load_registry\n"
        "payload = json.load(open(sys.argv[1], encoding='utf-8'))\n"
        "ctx, _ = load_context(payload)\n"
        "print(json.dumps(load_registry()[payload['spec']['harness']].collect_memory(ctx).files))\n"
    )
    env = {**os.environ, "PYTHONPATH": str(Path(__file__).resolve().parent.parent.parent)}
    out = subprocess.run(
        [sys.executable, "-c", code, str(run.trial_dir / "spec.json")], capture_output=True, text=True, env=env, timeout=60
    )
    assert out.returncode == 0, out.stderr
    assert json.loads(out.stdout) == SEED


def test_h8_collect_memory_is_empty_when_memory_is_off(adapter_id, world):
    run = world.run(adapter_id, "echo_memory", timeout=120)
    assert run.result["trace"]["memory_final"] == {}


# ------------------------------------------------------------------ H-9


@pytest.mark.parametrize("scenario,kw", [("shell_then_answer", {}), ("loop_tools", {"max_steps": 3}), ("malformed_tool", {})])
def test_h9_steps_equal_the_count_of_ok_api_call_events(adapter_id, world, scenario, kw):
    run = world.run(adapter_id, scenario, timeout=120, **kw)
    ok = [e for e in run.events if e["kind"] == "api_call" and e["status"] == "ok"]
    assert run.result["outcome"]["steps"] == len(ok)
    assert run.result["outcome"]["usage"]["api_calls"] == len(ok)


def test_h9_the_step_cap_is_reported_as_max_steps(adapter_id, world):
    run = world.run(adapter_id, "loop_tools", timeout=120, max_steps=3)
    assert run.result["outcome"]["exit_reason"] == "max_steps"
    assert run.result["passed"] is False
    assert run.result["outcome"]["steps"] == 3


# ------------------------------------------------------------------ H-10, M-1


def _adapter_sources() -> list[Path]:
    return [p for p in ADAPTERS_DIR.rglob("*.py") if "__pycache__" not in p.parts]


def test_h10_no_adapter_reads_a_key_directly():
    offenders = [p.name for p in _adapter_sources() if "API_KEY" in p.read_text(encoding="utf-8")]
    assert offenders == []


def test_m1_no_adapter_branches_on_a_model_id_or_provider_slug():
    """base.py is excluded: its comments reproduce ADAPTERS.md verbatim, examples included
    (recorded in DESIGN.md 11)."""
    pattern = re.compile(r"model-a|model-b|anthropic/|openai/|google/|meta-llama/|mistralai/")
    offenders = [
        p.name for p in _adapter_sources() if p.name != "base.py" and pattern.search(p.read_text(encoding="utf-8"))
    ]
    assert offenders == []


# ------------------------------------------------------------------ H-11


def test_h11_final_response_is_the_last_assistant_message_untrimmed(adapter_id, world):
    run = world.run(adapter_id, "padded", timeout=120)
    assert run.result["outcome"]["final_response"] == "  Done.\nFINAL: 8081  \n\n"
    assert run.result["passed"] is True  # extraction of FINAL: is the grader's job


# ------------------------------------------------------------------ M-3


def test_m3_every_request_that_reaches_the_provider_is_an_api_call_event(adapter_id, world):
    """The stub answers 429 on its first 2 requests. Whatever the harness does about it, the
    number of requests the provider saw equals the number of api_call events, and the 429 is on
    the first of them: no retry hides inside a library."""
    run = world.run(adapter_id, "rate_limit_twice", timeout=120)
    calls = run.kinds("api_call")
    assert len(run.chat_requests) == len(calls)
    assert calls[0]["http_status"] == 429
    assert all(c["status"] in ("retry", "error", "ok") for c in calls)
    if calls[0]["status"] == "error":
        assert run.result["status"] == "errored" and run.result["error_class"] == "rate_limited"


# ------------------------------------------------------------------ M-4


def test_m4_the_key_never_appears_in_a_spec_a_result_or_a_log(adapter_id, world):
    run = world.run(adapter_id, "shell_then_answer", timeout=120)
    assert SENTINEL_KEY not in json.dumps(run.spec)
    assert SENTINEL_KEY not in json.dumps(run.result)
    for log in ("child.stdout.log", "child.stderr.log"):
        assert SENTINEL_KEY not in (run.trial_dir / "out" / log).read_text(encoding="utf-8", errors="replace")
    # The key did reach the provider: the harness sent it, only the platform never stores it.
    assert run.chat_requests[0]["headers"]["Authorization"] == f"Bearer {SENTINEL_KEY}"
