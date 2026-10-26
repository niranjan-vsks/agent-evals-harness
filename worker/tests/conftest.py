"""Shared fixtures: a throwaway tasks directory, a runner config with short kill margins, and
a TrialSpec builder."""
import json
import os
import shutil
import tempfile
import uuid
from pathlib import Path
from typing import Any

import pytest

from worker.runner import RunnerConfig
from worker.task_hash import task_hash

KEY_ENV = "STUB_API_KEY"
SENTINEL_KEY = "sk-sentinel-5d1b7e0c9a"


def build_tasks_dir(root: Path) -> Path:
    fixture = root / "fixtures" / "det-06-ini"
    fixture.mkdir(parents=True)
    (fixture / "config.ini").write_text("[server]\nport = 8081\n[db]\nport = 5432\n", encoding="utf-8")
    (fixture / "_hidden").mkdir()
    (fixture / "_hidden" / "expected.txt").write_text("42\n", encoding="utf-8")
    write_task(root, "det-06-ini", "fixtures/det-06-ini", [{"type": "exact_match", "expected": "8081"}])
    return root


@pytest.fixture
def tasks_dir(tmp_path: Path) -> Path:
    return build_tasks_dir(tmp_path / "tasks")


def write_task(root: Path, task_id: str, fixture_rel: str | None, graders: list[dict[str, Any]], prompt: str = "What is the server port? End with FINAL: <port>.") -> dict[str, Any]:
    task = {
        "id": task_id,
        "category": "neutral_deterministic",
        "prompt": prompt,
        "fixture_dir": fixture_rel,
        "memory_fixture": None,
        "graders": graders,
        "discriminates": [],
        "tags": [],
    }
    (root / f"{task_id}.json").write_text(json.dumps(task), encoding="utf-8")
    return task


@pytest.fixture
def runner_env(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, tasks_dir: Path) -> RunnerConfig:
    monkeypatch.setenv("WORKER_FAKE_ADAPTER", "1")
    monkeypatch.setenv("WORKER_ENV", "test")
    monkeypatch.setenv(KEY_ENV, SENTINEL_KEY)
    return RunnerConfig(
        work_dir=tmp_path / "work",
        tasks_dir=tasks_dir,
        keep_trial_dirs=False,
        kill_margin_seconds=1.0,
        term_grace_seconds=1.0,
    )


def hash_of(tasks_dir: Path, task_id: str = "det-06-ini") -> str:
    task = json.loads((tasks_dir / f"{task_id}.json").read_text(encoding="utf-8"))
    fixture = tasks_dir / task["fixture_dir"] if task.get("fixture_dir") else None
    return task_hash(task, fixture)


def make_spec(
    tasks_dir: Path,
    *,
    harness: str = "fake",
    mode: str = "ok",
    timeout: int = 30,
    task_id: str = "det-06-ini",
    attempt: int = 1,
    base_url: str = "http://127.0.0.1:9/v1",
    slug: str = "stub/plain",
    memory: dict[str, Any] | None = None,
    memory_seed: dict[str, str] | None = None,
    options: dict[str, Any] | None = None,
    tools: tuple[str, ...] = ("shell", "files"),
    max_steps: int = 15,
    skills: dict[str, Any] | None = None,
) -> dict[str, Any]:
    task = json.loads((tasks_dir / f"{task_id}.json").read_text(encoding="utf-8"))
    opts = {"mode": mode, **(options or {})}
    return {
        "trial_id": uuid.uuid4().hex[:20].upper(),
        "attempt": attempt,
        "seed": 7,
        "harness": harness,
        "model": {
            "id": "stub",
            "slug": slug,
            "base_url": base_url,
            "api_key_env": KEY_ENV,
            "input_price_per_mtok": 1.0,
            "output_price_per_mtok": 2.0,
            "context_window": 100000,
        },
        "settings": {
            "tools": list(tools),
            "memory": memory or {"mode": "off", "fixture": None, "fixture_hash": None},
            "skills": skills or {"enabled": False, "preload": []},
            "temperature": 0,
            "max_steps": max_steps,
            "max_output_tokens": 512,
            "timeout_seconds": timeout,
            "harness_options": opts,
        },
        "task": {
            "id": task_id,
            "version_hash": hash_of(tasks_dir, task_id),
            "prompt": task["prompt"],
            "fixture_dir": task.get("fixture_dir"),
            "memory_fixture": task.get("memory_fixture"),
            "graders": task["graders"],
        },
        "memory_seed": memory_seed,
    }


def pid_alive(pid: int) -> bool:
    if os.name == "nt":
        import subprocess

        out = subprocess.run(["tasklist", "/FI", f"PID eq {pid}", "/NH"], capture_output=True, text=True).stdout
        return str(pid) in out
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


@pytest.fixture(scope="module")
def stub():
    from worker.tests.stub_model_server import StubServer

    s = StubServer().start()
    yield s
    s.stop()


@pytest.fixture(scope="module")
def world(tmp_path_factory, stub):
    """Tasks dir plus a memoizing trial runner that keeps trial dirs (see harness_world)."""
    from worker.tests.harness_world import World

    base = tmp_path_factory.mktemp("world")
    mp = pytest.MonkeyPatch()
    mp.setenv(KEY_ENV, SENTINEL_KEY)
    yield World(base, build_tasks_dir(base / "tasks"), stub)
    mp.undo()


def agent_user_available() -> bool:
    """R-11 tests run the child as `agent`: that needs a POSIX root worker and the user the image creates."""
    if os.name != "posix" or os.geteuid() != 0:
        return False
    import pwd

    try:
        pwd.getpwnam("agent")
    except KeyError:
        return False
    return True


@pytest.fixture
def r11_cfg(monkeypatch: pytest.MonkeyPatch):
    """A runner config with run_as="agent". pytest's own tmp dirs are root-only (so the child could not even enter its trial dir): the work
    dir sits in a directory `agent` can enter, and the tasks in a root-only one next to it, as in the image."""
    if not agent_user_available():
        pytest.skip("needs a root worker and the `agent` user (the worker image)")
    monkeypatch.setenv(KEY_ENV, SENTINEL_KEY)
    base = Path(tempfile.mkdtemp(prefix="r11-", dir="/var/tmp"))
    base.chmod(0o755)
    private = base / "private"
    private.mkdir()
    private.chmod(0o700)
    tasks = build_tasks_dir(private / "tasks")
    yield RunnerConfig(
        work_dir=base / "work", tasks_dir=tasks, keep_trial_dirs=True, kill_margin_seconds=45.0, term_grace_seconds=2.0, run_as="agent"
    )
    shutil.rmtree(base, ignore_errors=True)
