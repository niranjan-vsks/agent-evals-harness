"""Hermes-specific facts the adapter depends on (ADAPTERS 3, DESIGN 14: A-1 to A-7, A-11 to A-13).

Each test pins a fact about the Hermes commit in the image, so a Hermes bump that changes it fails
here rather than silently changing what a trial measures.
"""
import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from worker.adapters import REGISTRY
from worker.adapters.hermes.adapter import HermesAdapter, hermes_config, _yaml
from worker.spec import build_context, parse_trial_spec
from worker.tests.conftest import SENTINEL_KEY, make_spec
from worker.tests.harness_world import SEED, SEEDED

pytestmark = pytest.mark.skipif("hermes" not in REGISTRY, reason="hermes adapter not registered")

REPO = Path(__file__).resolve().parent.parent.parent

# Builds an agent the way HermesAdapter.run does, then reports facts about it.
PROBE = r"""
import json, os, sys
os.environ["HERMES_YOLO_MODE"] = "1"
import run_agent
from hermes_cli.config import load_config_readonly

base_url, max_steps, seeded = sys.argv[1], int(sys.argv[2]), sys.argv[3] == "seeded"
cfg = load_config_readonly()
toolsets = ["terminal", "file"] + (["memory"] if seeded else [])
agent = run_agent.AIAgent(
    model="stub/plain", base_url=base_url, api_key="k", provider="openrouter", max_iterations=max_steps,
    enabled_toolsets=toolsets, disabled_toolsets=[] if seeded else ["memory"], quiet_mode=True,
    skip_context_files=True, skip_memory=not seeded, skip_background_review=True, cwd=os.getcwd(),
)
result = agent.run_conversation("hi")
print(json.dumps({
    "max_iterations": agent.max_iterations,
    "api_max_retries": agent._api_max_retries,
    "memory_enabled": agent._memory_enabled,
    "user_profile_enabled": agent._user_profile_enabled,
    "cfg": {
        "max_turns": cfg["agent"]["max_turns"],
        "coding_context": cfg["agent"]["coding_context"],
        "auto_recovery_cycles": cfg["agent"]["auto_recovery_cycles"],
        "approvals_mode": cfg["approvals"]["mode"],
        "tool_search": cfg["tools"]["tool_search"]["enabled"],
        "terminal_backend": cfg["terminal"]["backend"],
        "model_default": cfg["model"]["default"],
        "model_provider": cfg["model"]["provider"],
        "memory_enabled": cfg["memory"]["memory_enabled"],
        "user_profile_enabled": cfg["memory"]["user_profile_enabled"],
        "auto_load": cfg["skills"]["auto_load"],
    },
    "message_roles": [m.get("role") for m in result["messages"]],
    "cached_system_prompt": agent._cached_system_prompt,
}))
agent.close()
"""


def prepared(tmp_path: Path, tasks: Path, memory=None, seed=None, max_steps=7):
    """A trial dir after HermesAdapter.prepare(), plus its HERMES_HOME."""
    spec = make_spec(tasks, harness="hermes", memory=memory, memory_seed=seed, max_steps=max_steps)
    trial_dir = tmp_path / "trial"
    for sub in ("workspace", "out"):
        (trial_dir / sub).mkdir(parents=True)
    ctx = build_context(
        parse_trial_spec(spec),
        trial_dir=str(trial_dir),
        workspace_dir=str(trial_dir / "workspace"),
        events_path=str(trial_dir / "out" / "events.jsonl"),
        fixture_dir=None,
    )
    REGISTRY["hermes"].prepare(ctx)
    return ctx, trial_dir / "hermes_home"


def probe(home: Path, base_url: str, max_steps: int, mode: str) -> dict:
    env = {**os.environ, "HERMES_HOME": str(home), "PYTHONPATH": str(REPO), "HERMES_STREAM_RETRIES": "0"}
    out = subprocess.run(
        [sys.executable, "-c", PROBE, base_url, str(max_steps), mode],
        capture_output=True, text=True, env=env, cwd=str(home.parent), timeout=180,
    )
    assert out.returncode == 0, out.stderr[-2000:]
    return json.loads(out.stdout.strip().splitlines()[-1])


# ------------------------------------------------------------------ A-1, A-2


def test_a2_hermes_top_level_modules_import_by_bare_name():
    for name in ("run_agent", "toolsets", "hermes_constants", "tools.memory_tool", "tools.skills_sync"):
        assert importlib.util.find_spec(name) is not None, name


def test_the_adapter_version_is_the_pinned_commit_prefix():
    assert HermesAdapter.version == "f4ac0bea1e"


# ------------------------------------------------------------------ A-3: config.yaml nesting


@pytest.mark.parametrize("mode", ["off", "seeded"])
def test_a3_config_yaml_is_read_by_hermes_at_the_key_paths_the_adapter_writes(mode, stub, world, tmp_path):
    memory, seed = (SEEDED, SEED) if mode == "seeded" else (None, None)
    ctx, home = prepared(tmp_path, world.tasks, memory, seed, max_steps=7)
    facts = probe(home, stub.base_url, 7, mode)
    assert facts["max_iterations"] == 7  # constructor argument, as ADAPTERS 3 asserts
    assert facts["cfg"] == {
        "max_turns": 7,
        "coding_context": "off",        # the string, not YAML's boolean for an unquoted `off`
        "auto_recovery_cycles": 0,
        "approvals_mode": "off",
        "tool_search": "off",
        "terminal_backend": "local",
        "model_default": "stub/plain",
        "model_provider": "openrouter",
        "memory_enabled": mode == "seeded",
        "user_profile_enabled": mode == "seeded",
        "auto_load": [],
    }
    assert facts["api_max_retries"] == 1  # 0 is clamped to 1: a single attempt, no Hermes retries
    assert (facts["memory_enabled"], facts["user_profile_enabled"]) == (mode == "seeded", mode == "seeded")


def test_a3_the_yaml_writer_quotes_strings_and_nests():
    text = _yaml({"a": {"b": "off", "c": [1, "x"], "d": True}, "e": 3})
    assert text == 'a:\n  b: "off"\n  c: [1, "x"]\n  d: true\ne: 3'


def test_the_memory_toggle_is_the_only_config_difference_between_the_two_arms(world, tmp_path):
    """DESIGN 10.1: memory off vs seeded must differ in nothing else."""
    (tmp_path / "a").mkdir()
    (tmp_path / "b").mkdir()
    off, _ = prepared(tmp_path / "a", world.tasks)
    seeded, _ = prepared(tmp_path / "b", world.tasks, SEEDED, SEED)
    a, b = hermes_config(off), hermes_config(seeded)
    diff = {k for k in a if a[k] != b[k]}
    assert diff == {"memory"}


# ------------------------------------------------------------------ A-4: skills


def test_a4_a_bare_agent_does_not_seed_skills_and_the_adapter_does(world):
    off = world.run("hermes", "plain", timeout=120)
    assert not (off.trial_dir / "hermes_home" / "skills" / ".bundled_manifest").exists()
    on = world.run("hermes", "plain", timeout=120, skills={"enabled": True, "preload": []})
    assert on.result["status"] == "done", on.result.get("error_message")
    assert (on.trial_dir / "hermes_home" / "skills" / ".bundled_manifest").is_file()
    offered = {t["function"]["name"] for t in on.chat_requests[0]["body"]["tools"]}
    assert {"skills_list", "skill_view"} <= offered
    off_offered = {t["function"]["name"] for t in off.chat_requests[0]["body"]["tools"]}
    assert not {"skills_list", "skill_view", "skill_manage"} & off_offered


# ------------------------------------------------------------------ A-5: iteration cap


def test_a5_the_iteration_cap_reason_string_is_what_the_adapter_matches():
    spec = importlib.util.find_spec("agent.turn_finalizer")
    assert spec and spec.origin
    source = Path(spec.origin).read_text(encoding="utf-8")
    assert 'f"max_iterations_reached({api_call_count}/{agent.max_iterations})"' in source
    # and the behaviour: a model that never stops calling tools ends as max_steps
    # (asserted end to end in test_adapter_conformance.test_h9_the_step_cap_is_reported_as_max_steps)


# ------------------------------------------------------------------ A-6: system prompt


def test_a6_the_system_message_is_not_in_result_messages_but_is_captured_from_the_hook(stub, world, tmp_path):
    ctx, home = prepared(tmp_path, world.tasks, SEEDED, SEED)
    before = len(stub.requests)
    facts = probe(home, stub.base_url, 5, "seeded")
    assert "system" not in facts["message_roles"]
    sent = [r for r in stub.requests[before:] if r["path"].endswith("/chat/completions")][0]["body"]["messages"][0]
    assert sent["role"] == "system" and sent["content"] == facts["cached_system_prompt"]
    assert REGISTRY["hermes"].capabilities.system_prompt_capture is True


# ------------------------------------------------------------------ A-7: auxiliary calls


def test_a7_no_auxiliary_requests_and_session_totals_equal_the_sum_of_the_calls(world):
    run = world.run("hermes", "shell_then_answer", timeout=120)
    ok = [e for e in run.events if e["kind"] == "api_call" and e["status"] == "ok"]
    assert len(run.chat_requests) == len(ok) == 2  # a title or compression call would add a request
    usage = run.result["outcome"]["usage"]
    assert usage["input_tokens"] == sum(e["input_tokens"] for e in ok)
    assert usage["output_tokens"] == sum(e["output_tokens"] for e in ok)


# ------------------------------------------------------------------ A-11: explicit key and base_url


def test_a11_an_explicit_base_url_and_key_are_used_directly_with_the_slug_untouched(world):
    run = world.run("hermes", "shell_then_answer", timeout=120)
    first = run.chat_requests[0]
    assert first["headers"]["Authorization"] == f"Bearer {SENTINEL_KEY}"
    assert first["body"]["model"] == "stub/shell_then_answer"
    assert first["body"]["temperature"] == 0.0
    assert first["body"]["max_tokens"] == 512
    assert first["path"] == "/v1/chat/completions"


# ------------------------------------------------------------------ A-12: approvals


def test_a12_yolo_mode_lets_a_risky_command_run_without_a_prompt(world):
    run = world.run("hermes", "risky_command", timeout=120)
    assert run.result["status"] == "done"
    results = run.kinds("tool_result")
    assert len(results) == 1 and results[0]["is_error"] is False
    out = json.loads(results[0]["output"])
    assert out["exit_code"] == 0 and "risky-done" in out["output"]
    assert run.result["outcome"]["exit_reason"] == "completed"


# ------------------------------------------------------------------ A-13: run_budget_seconds


def test_a13_exceeding_run_budget_seconds_does_not_raise_or_abort(world):
    """timeout_seconds 1 is the budget handed to Hermes; start-up alone takes longer. Hermes
    still returns a normal result (here, the step cap). Only the runner kill bounds a trial."""
    run = world.run("hermes", "loop_tools", timeout=1, max_steps=3)
    assert run.result["status"] == "done", run.result.get("error_message")
    assert run.result["outcome"]["exit_reason"] == "max_steps"
    assert run.result["outcome"]["latency_ms"] > 1000


# ------------------------------------------------------------------ memory writes


def test_a_memory_tool_write_is_traced_and_stays_inside_the_trial(world):
    """all_tools calls the memory tool with junk arguments; the point is the event and the paths."""
    run = world.run("hermes", "all_tools", timeout=120, memory=SEEDED)
    writes = run.kinds("memory_write")
    assert writes and writes[0]["file"] in ("MEMORY.md", "USER.md")
    assert (run.trial_dir / "hermes_home" / "memories" / "MEMORY.md").is_file()
