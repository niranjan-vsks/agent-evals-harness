"""R-11: the trial child runs as an unprivileged user, and what it must not read is root-only.

The worker container runs as root. A child that is also root, and an agent whose shell is a child of it, can read every task
(`/tasks`: the expected answers and the `_hidden/` tests) and every `out/` directory. With WORKER_RUN_AS set, the runner starts the
child as that user and keeps its own work (fixture copy, grading, the files of `out/`) as root. These helpers are the POSIX plumbing:
resolving the user, handing the child's directories to it, and proving, with a process that really runs as that user, that the
paths it must not read are closed to it. The probe is what makes a misconfigured mount (a `/tasks` that is world-readable) a refused
trial, not a quiet leak.
"""
import os
import stat
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path


class PrivilegeError(RuntimeError):
    """The child cannot be run as the unprivileged user, or a path it must not read is open to it. The trial is a worker_crash."""


@dataclass(frozen=True)
class AgentUser:
    name: str
    uid: int
    gid: int


def resolve_user(name: str) -> AgentUser:
    if os.name == "nt":
        raise PrivilegeError(f"WORKER_RUN_AS={name!r}: running the child as another user is POSIX only")
    if os.geteuid() != 0:
        raise PrivilegeError(f"WORKER_RUN_AS={name!r}: the worker must run as root to drop the child's privileges (euid {os.geteuid()})")
    import pwd

    try:
        entry = pwd.getpwnam(name)
    except KeyError:
        raise PrivilegeError(f"WORKER_RUN_AS={name!r}: no such user in this container") from None
    if entry.pw_uid == 0:
        raise PrivilegeError(f"WORKER_RUN_AS={name!r} is root")
    return AgentUser(name, entry.pw_uid, entry.pw_gid)


def chown_tree(path: Path, user: AgentUser) -> None:
    """The path and everything under it. Symlinks are changed themselves, never followed."""
    os.chown(path, user.uid, user.gid, follow_symlinks=False)
    for root, dirs, files in os.walk(path):
        for name in dirs + files:
            os.chown(os.path.join(root, name), user.uid, user.gid, follow_symlinks=False)


_PROBE = "import os, sys\nprint('\\n'.join(p for p in sys.argv[1:] if os.access(p, os.R_OK) or os.access(p, os.X_OK)))\n"


def open_to(user: AgentUser, paths: list[Path]) -> list[str]:
    """The paths the user can read or enter, asked of a process that runs as the user (a mode check would miss a mount that ignores chmod)."""
    done = subprocess.run(
        [sys.executable, "-I", "-c", _PROBE, *map(str, paths)],
        user=user.uid,
        group=user.gid,
        extra_groups=[],
        cwd="/",
        env={},
        capture_output=True,
        text=True,
        timeout=30,
    )
    if done.returncode != 0:
        raise PrivilegeError(f"the access probe as {user.name} failed (exit {done.returncode}): {done.stderr[-300:]}")
    return [line for line in done.stdout.splitlines() if line]


def assert_closed_to(user: AgentUser, paths: list[Path]) -> None:
    opened = open_to(user, paths)
    if opened:
        raise PrivilegeError(f"{', '.join(opened)} is readable by {user.name}; the task answers and the trial's out/ must be root-only (ADAPTERS R-11)")


def read_child_file(directory: Path, name: str) -> bytes | None:
    """A file the child wrote in a directory it owns, read as root: never through a symlink the child may have planted (the directory
    itself, or the file). None when it is not there or is not a regular file."""
    if os.name == "nt":
        p = directory / name
        return p.read_bytes() if p.is_file() else None
    try:
        dir_fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    except OSError:
        return None
    try:
        try:
            fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=dir_fd)  # NONBLOCK: a FIFO planted there must not hang the runner
        except OSError:
            return None
        with os.fdopen(fd, "rb") as f:
            return f.read() if stat.S_ISREG(os.fstat(f.fileno()).st_mode) else None
    finally:
        os.close(dir_fd)
