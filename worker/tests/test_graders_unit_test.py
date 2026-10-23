"""unit_test grader (DESIGN 7.3, R-7): hidden files arrive after the run, pass iff exit 0."""
import sys
from pathlib import Path

import pytest

from worker.graders import GraderError, run_graders
from worker.graders.exact_match import SpecProblem
from worker.graders.unit_test import TAIL_CHARS, grade_unit_test
from worker.tests.test_graders import make_ctx, make_result

HIDDEN_TEST = (
    "from slug import slugify\n"
    "\n"
    "def test_basic():\n"
    "    assert slugify('Hello, World!') == 'hello-world'\n"
    "\n"
    "def test_collapses_runs():\n"
    "    assert slugify('a   b--c') == 'a-b-c'\n"
)
RIGHT = "import re\n\ndef slugify(s):\n    return re.sub(r'[^a-z0-9]+', '-', s.lower()).strip('-')\n"
WRONG = "def slugify(s):\n    return s.lower().replace(' ', '-')\n"
SPEC = {"type": "unit_test", "hidden_files": ["tests/test_slug.py"], "command": "python -m pytest -q tests/test_slug.py", "timeout_seconds": 60}


@pytest.fixture
def fixture_dir(tmp_path: Path) -> Path:
    fx = tmp_path / "fx"
    (fx / "_hidden" / "tests").mkdir(parents=True)
    (fx / "_hidden" / "tests" / "test_slug.py").write_text(HIDDEN_TEST, encoding="utf-8")
    return fx


@pytest.fixture
def workspace(tmp_path: Path) -> Path:
    ws = tmp_path / "ws"
    ws.mkdir()
    return ws


def grade(workspace, fixture_dir, **over):
    return grade_unit_test({**SPEC, **over}, str(workspace), str(fixture_dir))


def test_a_correct_solution_passes_and_the_details_carry_the_pytest_output(workspace, fixture_dir):
    (workspace / "slug.py").write_text(RIGHT, encoding="utf-8")
    ok, d = grade(workspace, fixture_dir)
    assert ok and d["exit_code"] == 0 and not d["timed_out"]
    assert "2 passed" in d["output"] and d["command"] == SPEC["command"]


def test_a_plausible_wrong_solution_fails(workspace, fixture_dir):
    (workspace / "slug.py").write_text(WRONG, encoding="utf-8")
    ok, d = grade(workspace, fixture_dir)
    assert not ok and d["exit_code"] == 1
    assert "failed" in d["output"] and "test_basic" in d["output"]


def test_no_solution_at_all_fails(workspace, fixture_dir):
    ok, d = grade(workspace, fixture_dir)
    assert not ok and "ModuleNotFoundError" in d["output"]


def test_the_hidden_file_replaces_the_agents_own_file_at_the_same_path(workspace, fixture_dir):
    (workspace / "slug.py").write_text(WRONG, encoding="utf-8")
    (workspace / "tests").mkdir()
    (workspace / "tests" / "test_slug.py").write_text("def test_agent_wrote_this():\n    assert True\n", encoding="utf-8")
    ok, _ = grade(workspace, fixture_dir)
    assert not ok, "the agent's own test file must not stand in for the hidden one"
    assert (workspace / "tests" / "test_slug.py").read_text(encoding="utf-8") == HIDDEN_TEST


def test_the_hidden_file_is_not_in_the_workspace_before_grading(workspace, fixture_dir):
    assert not (workspace / "tests").exists()
    (workspace / "slug.py").write_text(RIGHT, encoding="utf-8")
    grade(workspace, fixture_dir)
    assert (workspace / "tests" / "test_slug.py").is_file()


def test_the_workspace_is_left_without_a_pytest_cache(workspace, fixture_dir):
    (workspace / "slug.py").write_text(RIGHT, encoding="utf-8")
    grade(workspace, fixture_dir)
    assert not (workspace / ".pytest_cache").exists()
    assert not list(workspace.rglob("__pycache__"))


def test_a_hanging_command_is_killed_at_the_timeout(workspace, fixture_dir):
    (workspace / "slug.py").write_text("import time\ntime.sleep(60)\ndef slugify(s):\n    return s\n", encoding="utf-8")
    ok, d = grade(workspace, fixture_dir, timeout_seconds=2)
    assert not ok and d["timed_out"] and d["exit_code"] is None


def test_the_output_is_cut_to_its_tail(workspace, fixture_dir):
    command = f'"{sys.executable}" -c "print(\'y\' * 9000 + \'END\')"'
    _, d = grade(workspace, fixture_dir, command=command)
    assert len(d["output"]) == TAIL_CHARS and d["output"].rstrip().endswith("END")


def test_a_command_without_hidden_files_needs_no_fixture(workspace):
    ok, d = grade_unit_test({"type": "unit_test", "command": f'"{sys.executable}" -c "print(1)"'}, str(workspace), None)
    assert ok and d["output"].strip() == "1"


@pytest.mark.parametrize(
    "over",
    [
        {"command": ""},
        {"command": None},
        {"timeout_seconds": 0},
        {"timeout_seconds": "60"},
        {"hidden_files": ["tests/missing.py"]},
        {"hidden_files": ["../escape.py"]},
        {"hidden_files": ["/etc/passwd"]},
        {"hidden_files": "tests/test_slug.py"},
    ],
)
def test_a_malformed_spec_is_a_task_error(workspace, fixture_dir, over):
    with pytest.raises(SpecProblem):
        grade(workspace, fixture_dir, **over)


def test_hidden_files_without_a_fixture_directory_are_a_task_error(workspace):
    with pytest.raises(SpecProblem):
        grade_unit_test(SPEC, str(workspace), None)


def test_run_graders_maps_a_task_error_to_a_grader_error(workspace, fixture_dir):
    with pytest.raises(GraderError):
        run_graders([{**SPEC, "hidden_files": ["nope.py"]}], make_ctx(workspace, fixture_dir), make_result("x"))


def test_run_graders_records_the_result(workspace, fixture_dir):
    (workspace / "slug.py").write_text(RIGHT, encoding="utf-8")
    (result,) = run_graders([SPEC], make_ctx(workspace, fixture_dir), make_result("done"))
    assert (result.grader_type, result.passed) == ("unit_test", True)
