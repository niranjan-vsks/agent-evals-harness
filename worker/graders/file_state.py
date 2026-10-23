"""file_state grader. Reads the workspace; no side effects (DESIGN 7.3).

{"type":"file_state", "checks":[
   {"path":"config.json","exists":true},
   {"path":"config.json","json_path":"$.port","equals":8443},
   {"path":"sorted.txt","equals_file":"expected/sorted.txt"},
   {"path":"data/a.txt","exists":false}]}

All paths are relative to the workspace and may not escape it. equals_file is resolved under
<fixture_dir>/_hidden/, which the runner never copies into the workspace, so the agent cannot
read the expected answer, while the file stays inside the hashed fixture tree (R-6).
"""
import json
import re
from pathlib import Path
from typing import Any

from worker.graders.exact_match import SpecProblem

HIDDEN_DIR = "_hidden"
_JSON_PATH_TOKEN = re.compile(r"\.([A-Za-z_][A-Za-z0-9_]*)|\[(\d+)\]")
_JSON_PATH_FULL = re.compile(r"\$(?:\.[A-Za-z_][A-Za-z0-9_]*|\[\d+\])*")


def _resolve(root: Path, rel: str) -> Path | None:
    p = Path(rel)
    if p.is_absolute() or ".." in p.parts:
        return None
    return root / p


def json_path_get(doc: Any, path: str) -> tuple[bool, Any]:
    """Minimal JSONPath: $ then .key or [index]. Returns (found, value)."""
    if not path.startswith("$"):
        raise SpecProblem(f"json_path must start with $: {path!r}")
    if not _JSON_PATH_FULL.fullmatch(path):  # before walking, so a missing key cannot hide an unsupported suffix
        raise SpecProblem(f"unsupported json_path syntax: {path!r}")
    rest = path[1:]
    cur = doc
    pos = 0
    while pos < len(rest):
        m = _JSON_PATH_TOKEN.match(rest, pos)
        if not m:
            raise SpecProblem(f"unsupported json_path syntax: {path!r}")
        pos = m.end()
        if m.group(1) is not None:
            if not isinstance(cur, dict) or m.group(1) not in cur:
                return False, None
            cur = cur[m.group(1)]
        else:
            idx = int(m.group(2))
            if not isinstance(cur, list) or idx >= len(cur):
                return False, None
            cur = cur[idx]
    return True, cur


def json_equal(actual: Any, expected: Any) -> bool:
    """Equality that does not let True equal 1 or 1.0 equal True."""
    if isinstance(actual, bool) != isinstance(expected, bool):
        return False
    return actual == expected


def _check(check: dict[str, Any], workspace: Path, hidden: Path | None) -> tuple[bool, str]:
    target = _resolve(workspace, check.get("path", ""))
    if target is None or not check.get("path"):
        return False, "path escapes the workspace or is missing"

    if "exists" in check:
        present = target.exists()
        return present == bool(check["exists"]), f"exists={present}"

    if "json_path" in check:
        if not target.is_file():
            return False, "file does not exist"
        try:
            doc = json.loads(target.read_text(encoding="utf-8"))
        except (ValueError, UnicodeDecodeError) as e:
            return False, f"not valid JSON: {e}"
        found, value = json_path_get(doc, check["json_path"])
        if not found:
            return False, f"{check['json_path']} not found"
        ok = json_equal(value, check.get("equals"))
        return ok, f"{check['json_path']}={value!r}"

    if "equals_file" in check:
        if hidden is None:
            raise SpecProblem("equals_file needs a task fixture directory")
        expected = _resolve(hidden, check["equals_file"])
        if expected is None or not expected.is_file():
            raise SpecProblem(f"equals_file {check['equals_file']!r} not found under {HIDDEN_DIR}/")
        if not target.is_file():
            return False, "file does not exist"
        same = target.read_bytes() == expected.read_bytes()
        return same, "bytes equal" if same else "bytes differ"

    raise SpecProblem(f"unsupported file_state check: {sorted(check)}")


def grade_file_state(spec: dict[str, Any], workspace_dir: str, fixture_dir: str | None) -> tuple[bool, dict[str, Any]]:
    checks = spec.get("checks")
    if not isinstance(checks, list) or not checks:
        raise SpecProblem("file_state needs a non-empty checks array")
    workspace = Path(workspace_dir)
    hidden = Path(fixture_dir) / HIDDEN_DIR if fixture_dir else None
    results = []
    for check in checks:
        ok, reason = _check(check, workspace, hidden)
        results.append({"check": check, "passed": ok, "reason": reason})
    return all(r["passed"] for r in results), {"checks": results}
