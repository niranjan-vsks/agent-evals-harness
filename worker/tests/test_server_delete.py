"""DELETE /trials/{trial_id}: cancel a running trial's child through the active-trials registry."""
import os
import signal
import subprocess
import sys
import threading
import time

import pytest
from fastapi.testclient import TestClient

from worker import active_trials, server

POSIX_ONLY = pytest.mark.skipif(sys.platform == "win32", reason="process groups and SIGKILL escalation are POSIX behaviour")

# A pid that cannot belong to any process or group (Linux pid_max is at most 2**22, Windows pids are multiples of 4).
# Never 0: os.killpg(0, ...) would signal pytest's own process group.
BOGUS_PID = 2**22 + 1


class FakeProc:
    """Stands in for a Popen without a process behind it. Its pid can never be a real pid or group."""

    def __init__(self, running: bool = True) -> None:
        assert BOGUS_PID not in (0, 1, os.getpid())
        self.pid = BOGUS_PID
        self.returncode: int | None = None if running else 0

    def poll(self) -> int | None:
        return self.returncode


def start_child(code: str = "import time; time.sleep(60)", **extra) -> subprocess.Popen:
    """A child started the way runner.py starts trial children (own session or group)."""
    kwargs: dict = dict(extra)
    if sys.platform == "win32":
        kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
    else:
        kwargs["start_new_session"] = True
    return subprocess.Popen([sys.executable, "-c", code], **kwargs)


def wait_exit(proc: subprocess.Popen, seconds: float = 10.0) -> bool:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            return True
        time.sleep(0.05)
    return False


def pid_alive(pid: int) -> bool:
    if sys.platform == "win32":
        out = subprocess.run(["tasklist", "/FI", f"PID eq {pid}", "/NH"], capture_output=True, text=True).stdout
        return str(pid) in out.split()
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    try:  # a zombie that nobody reaped is dead for our purposes
        with open(f"/proc/{pid}/stat") as f:
            return f.read().rsplit(")", 1)[1].split()[0] != "Z"
    except OSError:
        return True


def wait_dead(pid: int, seconds: float = 10.0) -> bool:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if not pid_alive(pid):
            return True
        time.sleep(0.05)
    return False


def force_kill_pid(pid: int) -> None:
    if sys.platform == "win32":
        subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"], capture_output=True)
    else:
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass


def read_line(proc: subprocess.Popen, seconds: float = 15.0) -> str:
    """First stdout line of the child, without hanging the test if the child never prints."""
    box: list[str] = []
    t = threading.Thread(target=lambda: box.append(proc.stdout.readline().strip()), daemon=True)
    t.start()
    t.join(seconds)
    assert box, "the child printed nothing"
    return box[0]


@pytest.fixture
def client() -> TestClient:
    return TestClient(server.app)


@pytest.fixture(autouse=True)
def clean_registry():
    yield
    with active_trials._lock:
        entries = list(active_trials._active.values())
        active_trials._active.clear()
    for e in entries:
        if e.timer is not None:
            e.timer.cancel()
        if isinstance(e.proc, subprocess.Popen) and e.proc.poll() is None:
            e.proc.kill()
            e.proc.wait()


@pytest.fixture
def child():
    proc = start_child()
    yield proc
    if proc.poll() is None:
        proc.kill()
    proc.wait()


@pytest.fixture
def sends(monkeypatch):
    """Replace the signal primitive by a recorder; `delivered` decides what it reports."""
    calls: list[bool] = []
    state = {"delivered": True, "delay": 0.0}

    def fake_send(proc, force: bool) -> bool:
        if state["delay"]:
            time.sleep(state["delay"])
        calls.append(force)
        return state["delivered"]

    monkeypatch.setattr(active_trials, "_send", fake_send)
    return calls, state


# ---- the route, with real children ----


def test_delete_kills_a_registered_child(client, child):
    active_trials.register("t-1", child)
    res = client.delete("/trials/t-1")
    assert res.status_code == 200
    assert res.json() == {"cancelled": True}
    assert wait_exit(child), "the child was not terminated"


def test_cancel_keeps_the_entry_until_the_runner_unregisters_it(child):
    active_trials.register("t-1", child)
    assert active_trials.cancel("t-1") is True
    assert wait_exit(child)
    assert "t-1" in active_trials._active
    active_trials.unregister("t-1", child)
    assert "t-1" not in active_trials._active


def test_delete_after_the_child_died_is_404_and_drops_the_entry(client, child):
    active_trials.register("t-1", child)
    assert client.delete("/trials/t-1").status_code == 200
    assert wait_exit(child)
    second = client.delete("/trials/t-1")
    assert second.status_code == 404
    assert "detail" in second.json()
    assert "t-1" not in active_trials._active


def test_unknown_id_is_404(client):
    res = client.delete("/trials/never-registered")
    assert res.status_code == 404
    assert "detail" in res.json()


def test_finished_process_is_404_and_dropped(client):
    proc = subprocess.Popen([sys.executable, "-c", "pass"])
    proc.wait()
    active_trials.register("t-done", proc)
    assert client.delete("/trials/t-done").status_code == 404
    assert "t-done" not in active_trials._active


def test_a_cancel_that_delivers_nothing_answers_404(client, sends):
    calls, state = sends
    state["delivered"] = False
    active_trials.register("t-1", FakeProc())
    res = client.delete("/trials/t-1")
    assert res.status_code == 404
    assert calls == [False]


def test_a_signal_to_a_pid_that_is_no_group_or_process_is_not_reported_as_delivered(client):
    """The real signal primitive on a pid that cannot exist: POSIX killpg raises, Windows taskkill exits non-zero."""
    active_trials.register("t-1", FakeProc())
    assert active_trials.cancel("t-1") is False
    assert client.delete("/trials/t-1").status_code == 404


@POSIX_ONLY
def test_a_child_that_is_not_a_group_leader_is_not_signalled_and_answers_404(client):
    # started WITHOUT start_new_session: its pid is not a process group id, so killpg(pid) finds no group
    proc = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
    try:
        active_trials.register("t-1", proc)
        assert active_trials.cancel("t-1") is False
        assert client.delete("/trials/t-1").status_code == 404
        time.sleep(0.2)
        assert proc.poll() is None, "the child was signalled although cancel reported False"
    finally:
        proc.kill()
        proc.wait()


# ---- the whole tree ----

GRANDCHILD_PARENT = (
    "import subprocess, sys, time\n"
    "g = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])\n"
    "print(g.pid, flush=True)\n"
    "time.sleep(60)\n"
)


def test_cancel_kills_a_grandchild_too():
    proc = start_child(GRANDCHILD_PARENT, stdout=subprocess.PIPE, text=True)
    grandchild = None
    try:
        grandchild = int(read_line(proc))
        assert pid_alive(grandchild)
        active_trials.register("t-1", proc)
        assert active_trials.cancel("t-1") is True
        assert wait_exit(proc), "the child survived"
        assert wait_dead(grandchild), "the grandchild survived the cancel"
    finally:
        if grandchild is not None:
            force_kill_pid(grandchild)
        if proc.poll() is None:
            proc.kill()
        proc.wait()
        proc.stdout.close()


# ---- escalation ----

IGNORES_SIGTERM = (
    "import signal, time\n"
    "signal.signal(signal.SIGTERM, signal.SIG_IGN)\n"
    "print('ready', flush=True)\n"
    "time.sleep(60)\n"
)


@POSIX_ONLY
def test_a_child_that_ignores_sigterm_is_sigkilled_by_the_timer(monkeypatch):
    monkeypatch.setattr(active_trials, "GRACE_SECONDS", 0.5)
    proc = start_child(IGNORES_SIGTERM, stdout=subprocess.PIPE, text=True)
    try:
        assert read_line(proc) == "ready"
        active_trials.register("t-1", proc)
        assert active_trials.cancel("t-1") is True
        time.sleep(0.2)
        assert proc.poll() is None, "SIGTERM was ignored, so the child must still be alive before the grace ends"
        assert wait_exit(proc, 5.0), "the escalation never killed the child"
        assert proc.returncode == -signal.SIGKILL
    finally:
        if proc.poll() is None:
            proc.kill()
        proc.wait()
        proc.stdout.close()


@POSIX_ONLY
def test_a_second_delete_on_a_signalled_child_sends_sigkill_at_once(client, monkeypatch):
    monkeypatch.setattr(active_trials, "GRACE_SECONDS", 60.0)
    proc = start_child(IGNORES_SIGTERM, stdout=subprocess.PIPE, text=True)
    try:
        assert read_line(proc) == "ready"
        active_trials.register("t-1", proc)
        assert client.delete("/trials/t-1").status_code == 200
        time.sleep(0.2)
        assert proc.poll() is None
        assert client.delete("/trials/t-1").status_code == 200  # the escalation
        assert wait_exit(proc, 5.0)
        assert proc.returncode == -signal.SIGKILL
    finally:
        if proc.poll() is None:
            proc.kill()
        proc.wait()
        proc.stdout.close()


def test_the_timer_escalates_only_while_the_child_is_still_running(monkeypatch, sends):
    calls, _ = sends
    monkeypatch.setattr(active_trials, "GRACE_SECONDS", 0.2)
    stubborn = FakeProc()
    active_trials.register("t-1", stubborn)
    assert active_trials.cancel("t-1") is True
    assert calls == [False]
    time.sleep(0.6)
    assert calls == [False, True], "a child still running after the grace must be sent the forceful signal"

    polite = FakeProc()
    active_trials.register("t-2", polite)
    assert active_trials.cancel("t-2") is True
    polite.returncode = -15  # exits within the grace
    time.sleep(0.6)
    assert calls == [False, True, False], "no escalation for a child that already exited"


def test_unregister_cancels_the_escalation_timer(monkeypatch, sends):
    calls, _ = sends
    monkeypatch.setattr(active_trials, "GRACE_SECONDS", 0.2)
    proc = FakeProc()
    active_trials.register("t-1", proc)
    assert active_trials.cancel("t-1") is True
    active_trials.unregister("t-1", proc)
    time.sleep(0.6)
    assert calls == [False], "the runner is done with the child; nothing may be signalled after that"


def test_a_failed_first_signal_does_not_arm_the_escalation(sends):
    calls, state = sends
    state["delivered"] = False
    proc = FakeProc()
    active_trials.register("t-1", proc)
    assert active_trials.cancel("t-1") is False
    assert active_trials.cancel("t-1") is False
    assert calls == [False, False], "both attempts are first attempts (SIGTERM), neither jumps to SIGKILL"
    assert active_trials._active["t-1"].timer is None


def test_concurrent_cancels_send_one_sigterm_and_escalate_the_rest(monkeypatch, sends):
    calls, state = sends
    monkeypatch.setattr(active_trials, "GRACE_SECONDS", 60.0)
    state["delay"] = 0.05  # widens the window in which an unguarded second caller would also see "not signalled yet"
    active_trials.register("t-1", FakeProc())
    results: list[bool] = []
    threads = [threading.Thread(target=lambda: results.append(active_trials.cancel("t-1"))) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert results == [True] * 8
    assert sorted(calls) == [False] + [True] * 7, "exactly one SIGTERM, every later cancel is the escalation"


# ---- registry rules ----


def test_unregister_makes_cancel_false(child):
    active_trials.register("t-1", child)
    active_trials.unregister("t-1", child)
    active_trials.unregister("t-1", child)  # idempotent
    assert active_trials.cancel("t-1") is False
    assert child.poll() is None


def test_unregister_is_compare_and_delete():
    mine, other = FakeProc(), FakeProc()
    active_trials.register("t-1", mine)
    active_trials.unregister("t-1", other)  # someone else's proc: no-op
    assert active_trials._active["t-1"].proc is mine
    active_trials.unregister("t-1", mine)
    assert "t-1" not in active_trials._active


def test_an_older_run_cannot_unregister_a_newer_runs_entry():
    first, second = FakeProc(running=False), FakeProc()
    active_trials.register("t-1", first)  # attempt 1, since finished
    active_trials.register("t-1", second)  # attempt 2 replaces the stale entry
    active_trials.unregister("t-1", first)  # attempt 1's finally
    assert active_trials._active["t-1"].proc is second


def test_register_refuses_an_id_that_is_registered_to_a_running_proc():
    first, second = FakeProc(), FakeProc()
    active_trials.register("t-1", first)
    with pytest.raises(ValueError):
        active_trials.register("t-1", second)
    assert active_trials._active["t-1"].proc is first
    first.returncode = 0  # once the first has exited the id is free again
    active_trials.register("t-1", second)
    assert active_trials._active["t-1"].proc is second


def test_fake_procs_can_never_be_a_real_group():
    assert FakeProc().pid not in (0, 1, os.getpid())
    if hasattr(os, "getpgid"):
        with pytest.raises(ProcessLookupError):
            os.getpgid(FakeProc().pid)
