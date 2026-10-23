"""unit_test grader. Copies the task's hidden test files into the workspace, runs a command, and
passes iff it exits 0 (DESIGN 7.3).

{"type":"unit_test", "hidden_files":["tests/test_slug.py"],
 "command":"python -m pytest -q tests/test_slug.py", "timeout_seconds":60}

The runner calls this after run() returns and the agent has stopped (R-7), so the agent never
sees the files: they live in <fixture_dir>/_hidden/, which the runner does not copy into the
workspace (R-5), and are copied in here, over anything the agent wrote at the same path.

The command runs with the worker's own interpreter first on PATH, so `python -m pytest`
means the same thing on every host. PYTEST_ADDOPTS keeps `.pytest_cache` out of the workspace
(a file_state check could trip on it). The bound on a hanging test is the command timeout;
there is no per-test timeout because that needs a pytest plugin the worker does not install.
"""
import os
import shutil
import signal
import subprocess
import sys
from pathlib import Path
from typing import Any

from worker.graders.exact_match import SpecProblem
from worker.graders.file_state import HIDDEN_DIR

TAIL_CHARS = 4000
DEFAULT_TIMEOUT_SECONDS = 60


def _relative(rel: Any) -> Path:
    p = Path(rel) if isinstance(rel, str) and rel else None
    if p is None or p.is_absolute() or ".." in p.parts:
        raise SpecProblem(f"hidden_files entry {rel!r} must be a relative path inside the workspace")
    return p


def _kill(proc: subprocess.Popen) -> None:
    if os.name == "nt":
        subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], capture_output=True)
    else:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass


def grade_unit_test(spec: dict[str, Any], workspace_dir: str, fixture_dir: str | None) -> tuple[bool, dict[str, Any]]:
    command = spec.get("command")
    hidden_files = spec.get("hidden_files", [])
    timeout = spec.get("timeout_seconds", DEFAULT_TIMEOUT_SECONDS)
    if not isinstance(command, str) or not command.strip():
        raise SpecProblem("unit_test needs a command")
    if not isinstance(hidden_files, list):
        raise SpecProblem("unit_test hidden_files must be an array")
    if not isinstance(timeout, int) or isinstance(timeout, bool) or timeout < 1:
        raise SpecProblem("unit_test timeout_seconds must be a positive integer")
    workspace = Path(workspace_dir)
    if hidden_files:
        if fixture_dir is None:
            raise SpecProblem("unit_test hidden_files need a task fixture directory")
        source_root = Path(fixture_dir) / HIDDEN_DIR
        for rel in hidden_files:
            rel_path = _relative(rel)
            source = source_root / rel_path
            if not source.is_file():
                raise SpecProblem(f"hidden file {rel!r} not found under {HIDDEN_DIR}/")
            target = workspace / rel_path
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)

    env = dict(os.environ)
    env["PATH"] = str(Path(sys.executable).parent) + os.pathsep + env.get("PATH", "")
    env["PYTEST_ADDOPTS"] = "-p no:cacheprovider"
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    proc = subprocess.Popen(
        command, shell=True, cwd=workspace_dir, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, encoding="utf-8", errors="replace", start_new_session=os.name != "nt",
    )
    timed_out = False
    try:
        output, _ = proc.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        timed_out = True
        _kill(proc)
        output, _ = proc.communicate()
    exit_code = None if timed_out else proc.returncode
    return (not timed_out and exit_code == 0), {
        "command": command,
        "exit_code": exit_code,
        "timed_out": timed_out,
        "output": output[-TAIL_CHARS:],
    }
