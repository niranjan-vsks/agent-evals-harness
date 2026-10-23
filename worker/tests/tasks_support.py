"""Where the committed tasks are, from the host checkout or from the worker container (/tasks)."""
import importlib.util
import json
import os
import sys
from pathlib import Path
from types import ModuleType
from typing import Any


def tasks_root() -> Path:
    env = os.environ.get("TASKS_DIR")
    return Path(env) if env else Path(__file__).resolve().parents[2] / "tasks"


def task_ids() -> list[str]:
    return sorted(p.stem for p in tasks_root().glob("*.json"))


def load_task(task_id: str) -> dict[str, Any]:
    return json.loads((tasks_root() / f"{task_id}.json").read_text(encoding="utf-8"))


def fixture_dir(task: dict[str, Any]) -> Path | None:
    return tasks_root() / task["fixture_dir"] if task.get("fixture_dir") else None


def load_gen(name: str) -> ModuleType:
    """Imports tasks/gen/<name>.py with its own directory on sys.path (it imports _common)."""
    gen = tasks_root() / "gen"
    if str(gen) not in sys.path:
        sys.path.insert(0, str(gen))
    spec = importlib.util.spec_from_file_location(f"taskgen_{name}", gen / f"{name}.py")
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def memory_text(name: str = "team-memory-v1") -> dict[str, str]:
    root = tasks_root() / "memory" / name
    return {f.name: f.read_text(encoding="utf-8") for f in root.glob("*.md")}
