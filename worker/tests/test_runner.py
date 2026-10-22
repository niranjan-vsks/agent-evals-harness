"""Runner invariants R-1 to R-8 (ADAPTERS 6), exercised with the fake adapter."""
import dataclasses
import json
import os
import time
from pathlib import Path

from worker.runner import RunnerConfig, run_trial
from worker.tests.conftest import KEY_ENV, SENTINEL_KEY, hash_of, make_spec, pid_alive, write_task


def test_r1_each_attempt_is_a_fresh_process(runner_env, tasks_dir):
    """A module-level counter in the adapter is 1 in both attempts: no state carries over."""
    first = run_trial(make_spec(tasks_dir, mode="counter"), runner_env)
    second = run_trial(make_spec(tasks_dir, mode="counter", attempt=2), runner_env)
    assert first["outcome"]["final_response"] == "count=1"
    assert second["outcome"]["final_response"] == "count=1"


def test_r1_child_env_is_minimal(runner_env, tasks_dir, monkeypatch):
    """Only the key named in the spec crosses into the child; other provider keys stay behind."""
    monkeypatch.setenv("OTHER_PROVIDER_KEY", "should-not-leak")
    monkeypatch.setenv("OPENROUTER_API_KEY", "should-not-leak-either")
    res = run_trial(make_spec(tasks_dir, mode="env"), runner_env)
    assert res["outcome"]["final_response"] == KEY_ENV


def test_r1_child_home_and_temp_are_inside_the_trial_dir(runner_env, tasks_dir):
    res = run_trial(make_spec(tasks_dir, mode="paths"), runner_env)
    home, tmpdir, hermes_home = res["outcome"]["final_response"].split("|")
    for value in (home, tmpdir, hermes_home):
        assert os.sep + "trials" + os.sep in value


def test_r2_stalled_child_is_killed_and_scored_as_timeout(runner_env, tasks_dir):
    spec = make_spec(tasks_dir, mode="stall", timeout=2)
    started = time.monotonic()
    res = run_trial(spec, runner_env)
    elapsed = time.monotonic() - started
    assert res["status"] == "done"
    assert res["outcome"]["exit_reason"] == "timeout"
    assert res["passed"] is False
    assert elapsed < 2 + 1 + 1 + 8, f"kill took {elapsed:.1f}s"
    assert [g["passed"] for g in res["grader_results"]] == [False]


def test_r2_killed_child_process_is_gone(runner_env, tasks_dir):
    res = run_trial(make_spec(tasks_dir, mode="stall", timeout=2), runner_env)
    pids = [e["pid"] for e in res["trace"]["events"] if e["kind"] == "pid"]
    assert len(pids) == 1
    assert not pid_alive(pids[0])


def test_r2_timeout_is_not_an_infra_error(runner_env, tasks_dir):
    res = run_trial(make_spec(tasks_dir, mode="stall", timeout=2), runner_env)
    assert res["error_class"] is None
    assert res["outcome"]["final_response"] is None


def test_r3_child_that_exits_without_result_is_a_worker_crash(runner_env, tasks_dir):
    res = run_trial(make_spec(tasks_dir, mode="crash"), runner_env)
    assert res["status"] == "errored"
    assert res["error_class"] == "worker_crash"
    assert "code 3" in res["error_message"]
    assert res["passed"] is None


def test_r3_adapter_exception_is_a_worker_crash_with_the_traceback(runner_env, tasks_dir):
    res = run_trial(make_spec(tasks_dir, mode="raise"), runner_env)
    assert res["error_class"] == "worker_crash"
    assert "fake programming error" in res["error_message"]


def test_r4_trace_is_assembled_from_disk_after_a_kill(runner_env, tasks_dir):
    res = run_trial(make_spec(tasks_dir, mode="stall", timeout=2), runner_env)
    kinds = [e["kind"] for e in res["trace"]["events"]]
    assert kinds[:5] == ["message", "message", "api_call", "api_call", "tool_call"]
    assert [e["seq"] for e in res["trace"]["events"]] == list(range(len(kinds)))


def test_r4_crash_keeps_partial_events_for_debugging(runner_env, tasks_dir):
    res = run_trial(make_spec(tasks_dir, mode="crash"), runner_env)
    assert [e["kind"] for e in res["partial_trace"]] == ["message", "message", "api_call"]


def test_r4_long_content_is_truncated_with_original_length(runner_env, tasks_dir):
    res = run_trial(make_spec(tasks_dir, mode="big_event"), runner_env)
    big = next(e for e in res["trace"]["events"] if e["kind"] == "tool_result")
    assert big["truncated"] is True
    assert big["orig_len"] == 25_000
    assert len(big["output"]) == 20_000


def test_r5_fixture_is_copied_not_linked_and_stays_unchanged(runner_env, tasks_dir):
    before = hash_of(tasks_dir)
    os.chmod(tasks_dir / "fixtures" / "det-06-ini" / "config.ini", 0o444)  # a read-only mount
    res = run_trial(make_spec(tasks_dir, mode="write_workspace"), runner_env)
    assert res["outcome"]["final_response"].startswith("FINAL: 8081|link=False")
    assert hash_of(tasks_dir) == before
    assert "port = 8081" in (tasks_dir / "fixtures" / "det-06-ini" / "config.ini").read_text()


def test_r6_changed_fixture_is_refused(runner_env, tasks_dir):
    spec = make_spec(tasks_dir)
    (tasks_dir / "fixtures" / "det-06-ini" / "config.ini").write_text("[server]\nport = 9999\n", encoding="utf-8")
    res = run_trial(spec, runner_env)
    assert res["status"] == "errored"
    assert res["error_class"] == "config_invalid"
    assert "changed on disk" in res["error_message"]


def test_r6_changed_task_json_is_refused(runner_env, tasks_dir):
    spec = make_spec(tasks_dir)
    write_task(tasks_dir, "det-06-ini", "fixtures/det-06-ini", [{"type": "exact_match", "expected": "9999"}])
    assert run_trial(spec, runner_env)["error_class"] == "config_invalid"


def test_r6_missing_task_is_refused(runner_env, tasks_dir):
    spec = make_spec(tasks_dir)
    (tasks_dir / "det-06-ini.json").unlink()
    assert run_trial(spec, runner_env)["error_class"] == "config_invalid"


def test_r7_hidden_files_are_not_in_the_workspace_during_the_run(runner_env, tasks_dir):
    res = run_trial(make_spec(tasks_dir, mode="list_workspace"), runner_env)
    listing = res["outcome"]["final_response"].removeprefix("FINAL: ").split(",")
    assert "config.ini" in listing
    assert not any("_hidden" in p or "expected.txt" in p for p in listing)


def test_r7_grading_runs_after_collect_memory_while_the_workspace_exists(runner_env, tasks_dir):
    """collect_memory writes collected.txt into the workspace; the file_state grader passes only
    if grading ran after it and before the directory was deleted."""
    write_task(
        tasks_dir,
        "det-06-ini",
        "fixtures/det-06-ini",
        [{"type": "file_state", "checks": [{"path": "collected.txt", "exists": True}, {"path": "answer.txt", "exists": True}]}],
    )
    res = run_trial(make_spec(tasks_dir, mode="write_workspace"), runner_env)
    assert res["passed"] is True
    assert res["grader_results"][0]["grader_type"] == "file_state"


def test_r8_trial_dir_is_deleted_unless_kept(runner_env, tasks_dir):
    run_trial(make_spec(tasks_dir), runner_env)
    assert not (runner_env.work_dir / "trials").exists() or not any((runner_env.work_dir / "trials").iterdir())

    keep = dataclasses.replace(runner_env, keep_trial_dirs=True)
    spec = make_spec(tasks_dir)
    run_trial(spec, keep)
    kept = keep.work_dir / "trials" / spec["trial_id"] / "1"
    assert (kept / "out" / "events.jsonl").is_file()
    assert (kept / "out" / "result.json").is_file()


def test_r8_trial_dir_is_deleted_after_a_kill_and_a_crash(runner_env, tasks_dir):
    run_trial(make_spec(tasks_dir, mode="stall", timeout=2), runner_env)
    run_trial(make_spec(tasks_dir, mode="crash"), runner_env)
    trials = runner_env.work_dir / "trials"
    assert not trials.exists() or not any(trials.iterdir())


def test_provider_429_is_an_infra_error_not_a_scored_failure(runner_env, tasks_dir):
    res = run_trial(make_spec(tasks_dir, mode="provider_429"), runner_env)
    assert res["status"] == "errored"
    assert res["error_class"] == "rate_limited"
    assert res["passed"] is None


def test_non_retryable_agent_error_is_a_scored_failure(runner_env, tasks_dir):
    res = run_trial(make_spec(tasks_dir, mode="agent_error"), runner_env)
    assert res["status"] == "done"
    assert res["outcome"]["exit_reason"] == "agent_error"
    assert res["passed"] is False


def test_passing_trial_returns_grader_results_and_usage(runner_env, tasks_dir):
    res = run_trial(make_spec(tasks_dir), runner_env)
    assert res["status"] == "done"
    assert res["passed"] is True
    assert res["grader_results"][0]["grader_type"] == "exact_match"
    assert res["outcome"]["usage"]["input_tokens"] == 10
    assert res["harness"] == {"id": "fake", "version": "0.0.1"}


def test_m4_api_key_never_appears_in_the_spec_or_the_result(runner_env, tasks_dir):
    spec = make_spec(tasks_dir, mode="secret_in_output")
    assert SENTINEL_KEY not in json.dumps(spec)
    res = run_trial(spec, runner_env)
    # The adapter put the key into its answer and notes on purpose; nothing leaves the runner with it.
    assert SENTINEL_KEY not in json.dumps(res)
    assert "[REDACTED]" in res["outcome"]["final_response"]


def test_invalid_spec_is_config_invalid(runner_env):
    res = run_trial({"trial_id": "X", "attempt": 1}, runner_env)
    assert res["error_class"] == "config_invalid"


def test_unknown_harness_is_config_invalid(runner_env, tasks_dir):
    res = run_trial(make_spec(tasks_dir, harness="nope"), runner_env)
    assert res["error_class"] == "config_invalid"
    assert "unknown harness" in res["error_message"]


def test_a_worker_without_the_models_key_variable_is_config_invalid_not_a_crash(runner_env, tasks_dir, monkeypatch):
    monkeypatch.delenv(KEY_ENV)
    res = run_trial(make_spec(tasks_dir), runner_env)
    assert res["status"] == "errored"
    assert res["error_class"] == "config_invalid"
    assert KEY_ENV in res["error_message"]
