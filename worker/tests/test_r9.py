"""R-9: the WORKER_MAX_PARALLEL bound with HTTP 429, and DELETE /trials/{id} against a real running child."""
import threading
import time
from dataclasses import replace
from functools import partial

import pytest
from fastapi.testclient import TestClient

from worker import active_trials, runner, server
from worker.runner import RunnerConfig, WorkerBusy, run_trial
from worker.tests.conftest import make_spec


def _wait_for(pred, timeout=20.0):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if pred():
            return True
        time.sleep(0.05)
    return False


@pytest.fixture
def cfg(runner_env: RunnerConfig) -> RunnerConfig:
    return replace(runner_env, max_parallel=1)


@pytest.fixture
def client(cfg: RunnerConfig, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setattr(server, "run_trial", partial(run_trial, cfg=cfg))
    return TestClient(server.app)


def _start(spec, cfg, out):
    t = threading.Thread(target=lambda: out.append(run_trial(spec, cfg)), daemon=True)
    t.start()
    return t


def _stalled_trial(tasks_dir, cfg, trial_id, attempt=1):
    spec = make_spec(tasks_dir, mode="stall", timeout=60, attempt=attempt)
    spec["trial_id"] = trial_id
    out: list = []
    t = _start(spec, cfg, out)
    assert _wait_for(lambda: trial_id in active_trials._active), "child never registered"
    return t, out


def test_env_sets_the_bound(monkeypatch):
    monkeypatch.setenv("WORKER_MAX_PARALLEL", "7")
    assert RunnerConfig.from_env().max_parallel == 7
    monkeypatch.delenv("WORKER_MAX_PARALLEL")
    assert RunnerConfig.from_env().max_parallel == 4
    monkeypatch.setenv("WORKER_MAX_PARALLEL", "0")
    assert RunnerConfig.from_env().max_parallel == 1  # a bound of 0 would refuse everything


def test_r9_over_capacity_raises_before_any_work(cfg, tasks_dir):
    t, out = _stalled_trial(tasks_dir, cfg, "t-busy-1")
    try:
        before = set(p.name for p in (cfg.work_dir / "trials").iterdir())
        with pytest.raises(WorkerBusy):
            run_trial(make_spec(tasks_dir, mode="ok"), cfg)
        assert set(p.name for p in (cfg.work_dir / "trials").iterdir()) == before  # nothing was created
    finally:
        assert active_trials.cancel("t-busy-1")
        t.join(30)
    assert runner._in_flight == 0


def test_r9_http_429_then_accepts_again_when_a_slot_frees(client, cfg, tasks_dir):
    t, out = _stalled_trial(tasks_dir, cfg, "t-busy-2")
    try:
        res = client.post("/trials/run", json=make_spec(tasks_dir, mode="ok"))
        assert res.status_code == 429
        assert "WORKER_MAX_PARALLEL" in res.json()["detail"]
    finally:
        assert client.delete("/trials/t-busy-2").status_code == 200
        t.join(30)
    ok = client.post("/trials/run", json=make_spec(tasks_dir, mode="ok"))
    assert ok.status_code == 200
    assert ok.json()["status"] == "done"


def test_slot_is_released_when_the_attempt_raises_or_errors(cfg, tasks_dir):
    spec = make_spec(tasks_dir, mode="ok")
    spec["harness"] = "nope"
    for _ in range(3):  # more than the bound of 1: a leaked slot would raise WorkerBusy
        assert run_trial(spec, cfg)["error_class"] == "config_invalid"
    assert runner._in_flight == 0


def test_delete_cancels_a_real_running_child_and_the_result_says_cancelled(client, cfg, tasks_dir):
    t, out = _stalled_trial(tasks_dir, cfg, "t-cancel-1")
    proc = active_trials._active["t-cancel-1"].proc
    events = cfg.work_dir / "trials" / "t-cancel-1" / "1" / "out" / "events.jsonl"
    assert _wait_for(lambda: events.is_file() and b'"pid"' in events.read_bytes()), "the child never reached its stall"
    res = client.delete("/trials/t-cancel-1")
    assert res.status_code == 200 and res.json() == {"cancelled": True}
    t.join(30)
    assert not t.is_alive()
    assert proc.poll() is not None  # the child is gone
    assert out[0]["status"] == "errored"
    assert out[0]["error_class"] == "cancelled"
    assert out[0]["partial_trace"]  # the events written before the kill are kept
    assert "t-cancel-1" not in active_trials._active  # unregistered in the finally
    assert client.delete("/trials/t-cancel-1").status_code == 404
    assert runner._in_flight == 0


def test_delete_of_an_unknown_or_finished_trial_is_404(client, cfg, tasks_dir):
    assert client.delete("/trials/never-ran").status_code == 404
    assert run_trial(make_spec(tasks_dir, mode="ok"), cfg)["status"] == "done"
    assert not active_trials._active  # a normal run unregisters its child


def test_a_timeout_is_still_a_scored_timeout_not_a_cancel(cfg, tasks_dir):
    res = run_trial(make_spec(tasks_dir, mode="stall", timeout=2), cfg)
    assert res["status"] == "done" and res["outcome"]["exit_reason"] == "timeout"
    assert not active_trials._active


def test_the_same_trial_id_is_refused_with_429_before_the_disk_is_touched(runner_env, tasks_dir):
    cfg = replace(runner_env, max_parallel=2)
    t, out = _stalled_trial(tasks_dir, cfg, "t-dup-1")
    events = cfg.work_dir / "trials" / "t-dup-1" / "1" / "out" / "events.jsonl"
    assert _wait_for(lambda: events.is_file() and b'"pid"' in events.read_bytes())
    before = events.read_bytes()
    try:
        for attempt in (1, 2):  # the same attempt shares the first child's directory; a new one does not
            spec = make_spec(tasks_dir, mode="ok", attempt=attempt)
            spec["trial_id"] = "t-dup-1"
            with pytest.raises(WorkerBusy, match="already running"):
                run_trial(spec, cfg)
            assert events.read_bytes() == before  # the running child's files are untouched
        assert active_trials._active["t-dup-1"].proc.poll() is None  # and so is the child
    finally:
        assert active_trials.cancel("t-dup-1")
        t.join(30)
    assert out[0]["error_class"] == "cancelled"
    assert runner._in_flight == 0


def test_register_refusal_is_the_backstop_when_the_pre_check_races(runner_env, tasks_dir, monkeypatch):
    cfg = replace(runner_env, max_parallel=2)
    t, out = _stalled_trial(tasks_dir, cfg, "t-dup-2")
    try:
        monkeypatch.setattr(active_trials, "is_running", lambda _id: False)  # both requests passed the pre-check
        spec = make_spec(tasks_dir, mode="ok", attempt=2)
        spec["trial_id"] = "t-dup-2"
        res = run_trial(spec, cfg)
        assert res["status"] == "errored" and res["error_class"] == "worker_crash"
        assert "already registered" in res["error_message"]
        assert active_trials._active["t-dup-2"].proc.poll() is None
    finally:
        assert active_trials.cancel("t-dup-2")
        t.join(30)
    assert runner._in_flight == 0


def test_the_slot_is_released_when_the_attempt_raises(cfg, tasks_dir, monkeypatch):
    def boom(*_a, **_k):
        raise OSError("disk gone")

    monkeypatch.setattr(runner, "_run_admitted", boom)
    for _ in range(3):  # the bound is 1: a leaked slot would turn the second call into WorkerBusy
        with pytest.raises(OSError):
            run_trial(make_spec(tasks_dir, mode="ok"), cfg)
    assert runner._in_flight == 0


def test_a_blank_or_bad_bound_falls_back_to_the_default(monkeypatch):
    for bad in ("", "abc", "4.0", " "):
        monkeypatch.setenv("WORKER_MAX_PARALLEL", bad)
        assert RunnerConfig.from_env().max_parallel == 4


def test_a_delete_that_beats_the_child_cancels_the_attempt_when_it_arrives(client, cfg, tasks_dir):
    spec = make_spec(tasks_dir, mode="stall", timeout=60)
    spec["trial_id"] = "t-early-1"
    assert client.delete("/trials/t-early-1").status_code == 404  # no child yet
    started = time.monotonic()
    res = run_trial(spec, cfg)
    assert time.monotonic() - started < 10  # no child was started, let alone stalled
    assert res["status"] == "errored" and res["error_class"] == "cancelled"
    assert not (cfg.work_dir / "trials" / "t-early-1").exists()
    assert runner._in_flight == 0
    # consumed once: the same id can run again
    again = make_spec(tasks_dir, mode="ok")
    again["trial_id"] = "t-early-1"
    assert run_trial(again, cfg)["status"] == "done"


def test_an_expired_tombstone_is_ignored(cfg, tasks_dir, monkeypatch):
    monkeypatch.setattr(active_trials, "TOMBSTONE_SECONDS", -1.0)
    assert active_trials.cancel("t-late-1") is False
    spec = make_spec(tasks_dir, mode="ok")
    spec["trial_id"] = "t-late-1"
    assert run_trial(spec, cfg)["status"] == "done"
