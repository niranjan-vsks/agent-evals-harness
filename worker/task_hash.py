"""Task identity hash. Pure. Must agree byte for byte with api/src/tasks/hash.ts.

sha256( canonical(task JSON minus "version_hash") + "\\n"
        + for each fixture file sorted by POSIX relative path: path + "\\0" + sha256hex(bytes) + "\\n" )

Canonical form: keys sorted recursively, no whitespace, UTF-8, non-ASCII kept as is. Task JSON
contains only integers and strings (tasks:lint rejects other numbers), so there are no float
formatting differences between the 2 implementations.
"""
import hashlib
import json
from pathlib import Path
from typing import Any


def canonical_json(obj: Any) -> str:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def fixture_entries(fixture_root: Path | None) -> list[tuple[str, str]]:
    """(POSIX relative path, sha256 hex of bytes) for every regular file, sorted by path."""
    if fixture_root is None:
        return []
    entries: list[tuple[str, str]] = []
    for p in fixture_root.rglob("*"):
        if p.is_file():
            entries.append((p.relative_to(fixture_root).as_posix(), hashlib.sha256(p.read_bytes()).hexdigest()))
    # Sort by the UTF-8 bytes of the path so the order is the same in every language.
    entries.sort(key=lambda e: e[0].encode("utf-8"))
    return entries


def task_hash(task_json: dict[str, Any], fixture_root: Path | None) -> str:
    body = {k: v for k, v in task_json.items() if k != "version_hash"}
    h = hashlib.sha256()
    h.update(canonical_json(body).encode("utf-8"))
    h.update(b"\n")
    for rel, digest in fixture_entries(fixture_root):
        h.update(rel.encode("utf-8") + b"\0" + digest.encode("ascii") + b"\n")
    return h.hexdigest()
