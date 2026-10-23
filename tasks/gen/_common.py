"""Shared by the task generators. Each generator exposes render() -> {path relative to tasks/: bytes}
and main(); writing is the only thing main() does, so a test can compare render() to the committed
files without touching the disk."""
import json
import sys
from pathlib import Path
from typing import Any

TASKS_DIR = Path(__file__).resolve().parent.parent


def task_json(task: dict[str, Any]) -> bytes:
    """The task file as committed: 2-space indent, key order as given, LF, final newline."""
    return (json.dumps(task, indent=2, ensure_ascii=False) + "\n").encode("utf-8")


def write_all(files: dict[str, bytes], out: Path) -> None:
    for rel, data in files.items():
        target = out / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)  # bytes, so no platform newline translation (task hashes cover raw bytes)
        print(f"wrote {rel} ({len(data)} bytes)")


def run(render, argv: list[str] | None = None) -> None:
    args = list(sys.argv[1:] if argv is None else argv)
    out = Path(args[0]) if args else TASKS_DIR
    write_all(render(), out)
