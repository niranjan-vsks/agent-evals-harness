"""R-11: the trial child runs as an unprivileged user and the runner, as root, does the rest. The end-to-end half, with both
adapters and a stub model that goes looking, is test_adapter_conformance.py::test_r11_*; these are the runner and helper halves."""
import dataclasses
import json
import os
import stat
from pathlib import Path

import pytest

from worker import privilege
from worker.adapters.base import HarnessRunResult, Usage
from worker.run_one import load_context
from worker.runner import RunnerConfig, _child_view, _read_child_result, _run_result_from_dict, run_trial
from worker.tests.conftest import make_spec

posix_only = pytest.mark.skipif(os.name == "nt", reason="file modes and links")


def test_the_child_view_of_a_spec_holds_no_grader_and_no_judge(tmp_path, tasks_dir):
    spec = make_spec(tasks_dir)
    spec["judge_model"] = dict(spec["model"])
    view = _child_view(spec)
    assert "graders" not in view["task"] and view["judge_model"] is None
    assert view["task"]["prompt"] == spec["task"]["prompt"] and view["trial_id"] == spec["trial_id"]
    assert spec["task"]["graders"] and spec["judge_model"] is not None  # the original is untouched: the parent still grades with it
    _, graders = load_context({"spec": view, "paths": {"trial_dir": "t", "workspace_dir": "w", "events_path": "e", "fixture_dir": None}})
    assert graders == []


def test_the_run_result_survives_the_trip_through_json():
    result = HarnessRunResult(
        final_response="FINAL: 1",
        exit_reason="completed",
        steps=2,
        usage=Usage(input_tokens=10, output_tokens=5, cache_read_tokens=None, reasoning_tokens=3, api_calls=2),
        harness_reported_cost_usd=0.5,
        system_prompt="sys",
        skills_invoked=("a", "b"),
        notes=("n",),
    )
    assert _run_result_from_dict(json.loads(json.dumps(dataclasses.asdict(result)))) == result


@pytest.mark.parametrize(
    "content",
    [b"not json", b"[]", b'{"run_result": {}}', b'{"run_result": 1, "memory_final": {}, "run_ms": 1}', b"\xff\xfe"],
)
def test_a_malformed_child_result_is_treated_as_missing(tmp_path, content):
    (tmp_path / "result.json").write_bytes(content)
    assert _read_child_result(tmp_path) is None


def test_a_missing_child_result_is_none(tmp_path):
    assert _read_child_result(tmp_path) is None


@posix_only
def test_a_file_the_child_planted_as_a_link_or_a_fifo_is_never_read_as_root(tmp_path):
    secret = tmp_path / "secret"
    secret.write_text("root only", encoding="utf-8")
    child = tmp_path / "child"
    child.mkdir()
    (child / "events.jsonl").symlink_to(secret)
    assert privilege.read_child_file(child, "events.jsonl") is None
    os.mkfifo(child / "result.json")
    assert privilege.read_child_file(child, "result.json") is None  # and a FIFO does not hang the runner
    (child / "plain.json").write_text("{}", encoding="utf-8")
    assert privilege.read_child_file(child, "plain.json") == b"{}"
    elsewhere = tmp_path / "elsewhere"
    elsewhere.symlink_to(tmp_path / "child", target_is_directory=True)  # the whole directory swapped for a link
    assert privilege.read_child_file(elsewhere, "plain.json") is None


def test_run_as_without_root_or_without_the_user_is_a_worker_crash_not_a_silent_root_child(runner_env, tasks_dir):
    cfg = dataclasses.replace(runner_env, run_as="no-such-user-for-r11")
    res = run_trial(make_spec(tasks_dir), cfg)
    assert res["status"] == "errored" and res["error_class"] == "worker_crash"
    assert "WORKER_RUN_AS" in res["error_message"]


def test_run_as_is_read_from_the_environment(monkeypatch):
    monkeypatch.setenv("WORKER_RUN_AS", " agent ")
    assert RunnerConfig.from_env().run_as == "agent"
    monkeypatch.setenv("WORKER_RUN_AS", "")
    assert RunnerConfig.from_env().run_as is None


def test_the_runner_collects_the_childs_files_into_out_and_grades_them(runner_env, tasks_dir):
    keep = dataclasses.replace(runner_env, keep_trial_dirs=True)
    spec = make_spec(tasks_dir)
    res = run_trial(spec, keep)
    assert res["status"] == "done" and res["passed"] is True
    kept = keep.work_dir / "trials" / spec["trial_id"] / "1"
    assert (kept / "child" / "events.jsonl").is_file() and (kept / "child" / "result.json").is_file()
    assert (kept / "out" / "events.jsonl").read_bytes() == (kept / "child" / "events.jsonl").read_bytes()
    recorded = json.loads((kept / "out" / "result.json").read_text(encoding="utf-8"))
    assert [g["passed"] for g in recorded["grader_results"]] == [True]  # graded by the runner: the child's own file has no grader results
    assert "grader_results" not in json.loads((kept / "child" / "result.json").read_text(encoding="utf-8"))


def test_a_readable_tasks_dir_refuses_the_trial(r11_cfg, stub):
    r11_cfg.tasks_dir.parent.chmod(0o755)  # the mount point's parent is what keeps `agent` out: open it and the probe must say so
    res = run_trial(make_spec(r11_cfg.tasks_dir, base_url=stub.base_url, harness="minimal_loop"), r11_cfg)
    assert res["status"] == "errored" and res["error_class"] == "worker_crash"
    assert "readable by agent" in res["error_message"] and "R-11" in res["error_message"]


def test_the_probe_sees_what_a_process_running_as_agent_sees(r11_cfg):
    user = privilege.resolve_user("agent")
    assert privilege.open_to(user, [r11_cfg.tasks_dir]) == []
    r11_cfg.tasks_dir.parent.chmod(0o755)
    assert privilege.open_to(user, [r11_cfg.tasks_dir]) == [str(r11_cfg.tasks_dir)]
    mode = stat.S_IMODE(r11_cfg.tasks_dir.parent.stat().st_mode)
    assert mode == 0o755
