"""Reading and writing the trace file. Shared by adapters (writer) and the runner (reader).

The writer flushes every line (H-7): a trial killed by the runner must still leave the
trajectory up to the kill. The reader never trusts the child's memory (R-4): it parses the
file on disk, tolerating a final line cut short by the kill.
"""
import json
import threading
import time
from pathlib import Path
from typing import Any

MAX_FIELD_CHARS = 20_000


class TraceWriter:
    """Appends 1 JSON object per line to events_path, flushed per line. Thread safe."""

    def __init__(self, events_path: str | Path):
        self._path = Path(events_path)
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._t0 = time.monotonic()
        self._f = open(self._path, "a", encoding="utf-8", newline="\n")

    def emit(self, kind: str, **fields: Any) -> None:
        event = {"kind": kind, "t_ms": int((time.monotonic() - self._t0) * 1000), **fields}
        line = json.dumps(event, ensure_ascii=False)
        try:
            line.encode("utf-8")
        except UnicodeEncodeError:  # a lone surrogate in model text must not kill the trial
            line = line.encode("utf-8", "replace").decode("utf-8")
        with self._lock:
            self._f.write(line + "\n")
            self._f.flush()

    def close(self) -> None:
        with self._lock:
            self._f.close()


def write_events_fresh(events_path: str | Path, events: list[dict[str, Any]]) -> None:
    """Rewrites the file from scratch. prepare() uses this so it stays idempotent (H-5)."""
    p = Path(events_path)
    p.parent.mkdir(parents=True, exist_ok=True)
    with open(p, "w", encoding="utf-8", newline="\n") as f:
        for e in events:
            f.write(json.dumps({"t_ms": 0, **e}, ensure_ascii=False) + "\n")


def _truncate(event: dict[str, Any]) -> dict[str, Any]:
    longest = 0
    out = dict(event)
    for key, value in event.items():
        if isinstance(value, str) and len(value) > MAX_FIELD_CHARS:
            longest = max(longest, len(value))
            out[key] = value[:MAX_FIELD_CHARS]
    if longest:
        out["truncated"] = True
        out["orig_len"] = longest
    return out


def read_events(events_path: str | Path) -> list[dict[str, Any]]:
    """Events in file order with seq assigned by line order when the adapter omitted it."""
    p = Path(events_path)
    if not p.exists():
        return []
    events: list[dict[str, Any]] = []
    with open(p, "r", encoding="utf-8", errors="replace") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                e = json.loads(line)
            except json.JSONDecodeError:
                continue  # a line cut short by the kill
            if not isinstance(e, dict) or "kind" not in e:
                continue
            e.setdefault("seq", len(events))
            events.append(_truncate(e))
    return events
