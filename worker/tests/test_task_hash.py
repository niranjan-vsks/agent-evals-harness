"""worker/task_hash.py: the shared test vector (api/src/tasks/hash.spec.ts asserts the same value)
and the properties the runner's R-6 check depends on."""
import json
import os
from pathlib import Path

from worker.task_hash import canonical_json, fixture_entries, task_hash

TASKS = Path(os.environ.get("TASKS_DIR") or Path(__file__).resolve().parents[2] / "tasks")
VECTOR = TASKS / "_hashvector"


def load_vector():
    task = json.loads((VECTOR / "task.json").read_text(encoding="utf-8"))
    expected = (VECTOR / "expected.sha256").read_text(encoding="ascii").strip()
    return task, expected, VECTOR / "fixtures"


def test_the_vector_matches_its_expected_hash():
    task, expected, fixtures = load_vector()
    assert task_hash(task, fixtures) == expected


def test_fixture_files_are_listed_by_posix_path_sorted_by_utf8_bytes():
    _, _, fixtures = load_vector()
    assert [p for p, _ in fixture_entries(fixtures)] == ["Z.bin", "a.txt", "sub/b.txt"]


def test_canonical_form_sorts_by_code_point_and_keeps_unicode():
    # Python sorts str keys by code point, which is what api/src/common/canonical-json.ts reproduces.
    text = canonical_json({"\U0001F600": 1, "～": 2, "a": "café"})
    assert text == '{"a":"café","～":2,"\U0001F600":1}'


def test_version_hash_key_is_ignored_and_other_changes_are_not():
    task, expected, fixtures = load_vector()
    assert task_hash({**task, "version_hash": "x"}, fixtures) == expected
    assert task_hash({**task, "prompt": task["prompt"] + "!"}, fixtures) != expected


def test_no_fixture_is_a_valid_input():
    task, _, _ = load_vector()
    assert task_hash(task, None) != task_hash(task, VECTOR / "fixtures")


def test_the_real_tasks_hash_to_64_hex_characters():
    for name in ("det-06-ini", "mem-01-staging-db"):
        task = json.loads((TASKS / f"{name}.json").read_text(encoding="utf-8"))
        root = TASKS / task["fixture_dir"] if task["fixture_dir"] else None
        h = task_hash(task, root)
        assert len(h) == 64 and int(h, 16) >= 0
