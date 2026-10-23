"""Every committed memory fixture fits Hermes's character limits (ADAPTERS 3 step 3, H-1), and
both adapters accept it. A fixture over the limit would make a seeded Hermes config unrunnable."""
import os
from pathlib import Path

import pytest

from worker.adapters import REGISTRY
from worker.adapters.base import MemorySettings, Settings, SkillSettings

MEMORY_LIMIT = 2200
USER_LIMIT = 1375


def memory_root() -> Path:
    tasks = os.environ.get("TASKS_DIR")
    return (Path(tasks) if tasks else Path(__file__).resolve().parents[2] / "tasks") / "memory"


FIXTURES = sorted(p.name for p in memory_root().iterdir() if p.is_dir()) if memory_root().is_dir() else []


def test_there_is_at_least_the_team_fixture():
    assert "team-memory-v1" in FIXTURES


@pytest.mark.parametrize("name", FIXTURES)
def test_fixture_files_fit_the_hermes_limits(name):
    root = memory_root() / name
    assert len((root / "MEMORY.md").read_text(encoding="utf-8")) <= MEMORY_LIMIT
    assert len((root / "USER.md").read_text(encoding="utf-8")) <= USER_LIMIT


@pytest.mark.parametrize("name", FIXTURES)
@pytest.mark.parametrize("adapter_id", sorted(REGISTRY))
def test_every_adapter_accepts_every_committed_fixture(name, adapter_id, monkeypatch):
    monkeypatch.setenv("TASKS_DIR", str(memory_root().parent))
    settings = Settings(
        tools=("shell", "files"),
        memory=MemorySettings("seeded", name, "h"),
        skills=SkillSettings(False, ()),
        temperature=0.0,
        max_steps=15,
        max_output_tokens=2048,
        timeout_seconds=300,
        harness_options={},
    )
    assert REGISTRY[adapter_id].validate(settings) == []
