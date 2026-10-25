"""Registry of running trial child processes, so DELETE /trials/{trial_id} can cancel one.

The runner registers each child right after Popen and unregisters it, passing the same Popen, in a
finally (worker/runner.py, _run_in_dir). A cancelled attempt is reported by the runner as error_class
"cancelled" (was_signalled tells it a DELETE reached the child).

Contract
- register(trial_id, proc) refuses (ValueError) an id that is already registered to a child that is
  still running; a finished stale entry is replaced.
- unregister(trial_id, proc) is a compare-and-delete: it removes the entry only when the stored proc
  is that proc, so an older run of the same trial id cannot drop a newer run's entry.
- cancel(trial_id) signals the child's whole process group (POSIX: SIGTERM to the group; Windows:
  taskkill /T /F, which is already forceful) and returns True only when a signal was delivered. The
  entry stays until the runner unregisters it. A second cancel on an entry that was already signalled
  sends SIGKILL to the group, and a daemon timer does the same GRACE_SECONDS after the first signal if
  the child is still running (the same escalation as runner._kill_tree).

This module must not import runner.py (the runner imports the registry, not the reverse).

- A DELETE that finds no child (the trial is still between the start of POST /trials/run and Popen,
  or has not reached the worker yet) still answers 404, but leaves a short-lived tombstone for that
  trial id (TOMBSTONE_SECONDS). The runner consumes it before it touches the disk and right after it
  registers the child, and reports the attempt as cancelled instead of running it. The TTL is shorter
  than the API's 30 s re-queue backoff after an orphan recovery (which also sends a DELETE), so a
  re-dispatch of that trial is never hit by its own tombstone.

Known limits
- The signal goes to the child's process group only. The minimal_loop adapter starts every shell
  command with start_new_session=True, so each command is in its own session and survives a group
  SIGTERM until it finishes. Closing that gap belongs to the adapter (a SIGTERM handler that runs its
  leftover-process cleanup), which is outside this module.
"""
import os
import signal
import subprocess
import threading
import time

# How long a SIGTERMed child may take to exit before it is SIGKILLed (a module constant so tests can lower it).
GRACE_SECONDS = 10.0
# How long a DELETE for a trial with no registered child stays valid (see the module docstring).
TOMBSTONE_SECONDS = 20.0


class _Entry:
    def __init__(self, proc: subprocess.Popen) -> None:
        self.proc = proc
        self.signalled = False
        self.timer: threading.Timer | None = None


_lock = threading.Lock()
_active: dict[str, _Entry] = {}
_tombstones: dict[str, float] = {}  # trial id -> time.monotonic() deadline


def consume_tombstone(trial_id: str) -> bool:
    """True once, when an unexpired DELETE arrived for this trial id before its child existed."""
    with _lock:
        deadline = _tombstones.pop(trial_id, None)
    return deadline is not None and time.monotonic() < deadline


def register(trial_id: str, proc: subprocess.Popen) -> None:
    with _lock:
        current = _active.get(trial_id)
        if current is not None and current.proc.poll() is None:
            raise ValueError(f"trial {trial_id!r} is already registered to a running process")
        if current is not None and current.timer is not None:
            current.timer.cancel()
        _active[trial_id] = _Entry(proc)


def unregister(trial_id: str, proc: subprocess.Popen) -> None:
    """Remove the entry only when it belongs to `proc`; anything else is a no-op."""
    with _lock:
        entry = _active.get(trial_id)
        if entry is None or entry.proc is not proc:
            return
        if entry.timer is not None:
            entry.timer.cancel()
        del _active[trial_id]


def is_running(trial_id: str) -> bool:
    """True when a child is registered for this trial id and has not exited."""
    with _lock:
        entry = _active.get(trial_id)
        return entry is not None and entry.proc.poll() is None


def was_signalled(trial_id: str, proc: subprocess.Popen) -> bool:
    """True when cancel() delivered a signal to this proc (checked by the runner before it unregisters)."""
    with _lock:
        entry = _active.get(trial_id)
        return entry is not None and entry.proc is proc and entry.signalled


def _send(proc: subprocess.Popen, force: bool) -> bool:
    """Signal the child's whole tree; True only when a signal was actually delivered.

    The runner starts each child in its own session (POSIX) or process group (Windows), so the
    child's pid is also its process group id. A child that is not a group leader, or one that is gone,
    makes killpg raise ProcessLookupError, and a zombie group on some systems raises PermissionError.
    """
    if os.name == "nt":
        result = subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], capture_output=True)
        # taskkill exits non-zero when any process of the tree could not be terminated (one that was already
        # exiting, say) although the root was; the root's own SUCCESS line is what says the cancel landed.
        root_killed = f"SUCCESS: The process with PID {proc.pid} ".encode() in result.stdout
        return result.returncode == 0 or root_killed
    try:
        os.killpg(proc.pid, signal.SIGKILL if force else signal.SIGTERM)
    except (ProcessLookupError, PermissionError):
        return False
    return True


def _escalate(proc: subprocess.Popen) -> None:
    if proc.poll() is None:
        _send(proc, True)


def cancel(trial_id: str) -> bool:
    """True when a signal was delivered to a registered, still-running child's process group."""
    with _lock:
        entry = _active.get(trial_id)
        if entry is None:
            now = time.monotonic()
            for k in [k for k, d in _tombstones.items() if d <= now]:
                del _tombstones[k]
            _tombstones[trial_id] = now + TOMBSTONE_SECONDS
            return False
        if entry.proc.poll() is not None:
            # finished on its own: nothing to signal, and the entry is stale
            if entry.timer is not None:
                entry.timer.cancel()
            del _active[trial_id]
            return False
        force = entry.signalled
        entry.signalled = True  # claimed under the lock, so concurrent cancels send SIGTERM once and escalate after
        proc = entry.proc
    delivered = _send(proc, force)
    with _lock:
        if not delivered:
            if not force:
                entry.signalled = False  # nothing was sent, so a later cancel is still the first one
            return False
        if not force and entry.timer is None and _active.get(trial_id) is entry:
            entry.timer = threading.Timer(GRACE_SECONDS, _escalate, args=(proc,))
            entry.timer.daemon = True
            entry.timer.start()
    return True
