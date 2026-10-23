"""exact_match and file_state graders (DESIGN 7.3)."""
import json
from pathlib import Path

import pytest

from worker.adapters.base import (
    HarnessRunResult,
    MemorySettings,
    ModelSpec,
    Settings,
    SkillSettings,
    TaskSpec,
    TrialContext,
    Usage,
)
from worker.graders import GraderError, failed_for_timeout, run_graders
from worker.graders.exact_match import SpecProblem, extract_answer, grade_exact_match
from worker.graders.file_state import grade_file_state, json_path_get


def em(response, **spec):
    return grade_exact_match({"type": "exact_match", **spec}, response)


class TestExactMatch:
    def test_takes_the_last_final_line(self):
        ok, d = em("thinking\nFINAL: 1\nmore\nFINAL: 8081\n", expected="8081")
        assert ok and d["extracted"] == "8081" and d["used_fallback"] is False

    def test_falls_back_to_the_whole_response(self):
        ok, d = em("8081", expected="8081")
        assert ok and d["used_fallback"] is True

    def test_no_match_is_a_failure_with_the_extracted_answer_recorded(self):
        ok, d = em("FINAL: 8082", expected="8081")
        assert not ok and d["extracted"] == "8082"

    def test_default_normalization_trims_only(self):
        assert em("FINAL:   Marco  ", expected="Marco")[0]
        assert not em("FINAL: marco", expected="Marco")[0]

    def test_configured_normalization(self):
        assert em("FINAL:  MARCO   Polo ", expected="marco polo", normalize=["trim", "lowercase", "collapse_whitespace"])[0]

    def test_expected_may_be_a_list(self):
        assert em("FINAL: b", expected=["a", "b"])[0]
        assert not em("FINAL: c", expected=["a", "b"])[0]

    def test_regex_must_match_the_whole_answer(self):
        assert em("FINAL: 12.50", expected_regex=r"\d+\.\d{2}")[0]
        assert not em("FINAL: 12.505", expected_regex=r"\d+\.\d{2}")[0]

    def test_final_marker_is_case_sensitive_and_anchored(self):
        assert extract_answer("final: 1", "final_line") == ("final: 1", True)
        assert extract_answer("so FINAL: 1", "final_line") == ("so FINAL: 1", True)

    def test_crlf_line_endings(self):
        assert em("FINAL: 8081\r\n", expected="8081")[0]

    def test_no_final_response_fails_without_raising(self):
        ok, d = em(None, expected="x")
        assert not ok and d["reason"] == "no final response"

    def test_a_spec_with_no_expectation_is_a_task_error(self):
        with pytest.raises(SpecProblem):
            em("x")

    def test_unknown_normalize_op_is_a_task_error(self):
        with pytest.raises(SpecProblem):
            em("x", expected="x", normalize=["rot13"])


@pytest.fixture
def workspace(tmp_path: Path) -> Path:
    ws = tmp_path / "ws"
    (ws / "data").mkdir(parents=True)
    (ws / "config.json").write_text(json.dumps({"log_level": "WARN", "port": 8443, "metrics": True, "list": [1, {"a": 2}]}))
    (ws / "sorted.txt").write_bytes(b"-3\n1\n2\n")
    return ws


@pytest.fixture
def fixture_dir(tmp_path: Path) -> Path:
    fx = tmp_path / "fx"
    (fx / "_hidden" / "expected").mkdir(parents=True)
    (fx / "_hidden" / "expected" / "sorted.txt").write_bytes(b"-3\n1\n2\n")
    return fx


def fs(workspace, fixture_dir, *checks):
    return grade_file_state({"type": "file_state", "checks": list(checks)}, str(workspace), str(fixture_dir))


class TestFileState:
    def test_exists_true_and_false(self, workspace, fixture_dir):
        assert fs(workspace, fixture_dir, {"path": "config.json", "exists": True}, {"path": "data/a.txt", "exists": False})[0]
        assert not fs(workspace, fixture_dir, {"path": "data/a.txt", "exists": True})[0]

    def test_json_path_equals(self, workspace, fixture_dir):
        ok, d = fs(
            workspace,
            fixture_dir,
            {"path": "config.json", "json_path": "$.port", "equals": 8443},
            {"path": "config.json", "json_path": "$.log_level", "equals": "WARN"},
            {"path": "config.json", "json_path": "$.metrics", "equals": True},
            {"path": "config.json", "json_path": "$.list[1].a", "equals": 2},
        )
        assert ok and len(d["checks"]) == 4

    def test_wrong_value_and_missing_key_fail(self, workspace, fixture_dir):
        assert not fs(workspace, fixture_dir, {"path": "config.json", "json_path": "$.port", "equals": 80})[0]
        assert not fs(workspace, fixture_dir, {"path": "config.json", "json_path": "$.nope", "equals": 1})[0]

    def test_true_does_not_equal_one(self, workspace, fixture_dir):
        (workspace / "n.json").write_text('{"v": 1, "b": true}')
        assert not fs(workspace, fixture_dir, {"path": "n.json", "json_path": "$.b", "equals": 1})[0]
        assert not fs(workspace, fixture_dir, {"path": "n.json", "json_path": "$.v", "equals": True})[0]

    def test_invalid_json_fails(self, workspace, fixture_dir):
        (workspace / "bad.json").write_text("{nope")
        ok, d = fs(workspace, fixture_dir, {"path": "bad.json", "json_path": "$.a", "equals": 1})
        assert not ok and "not valid JSON" in d["checks"][0]["reason"]

    def test_equals_file_uses_the_hidden_dir(self, workspace, fixture_dir):
        assert fs(workspace, fixture_dir, {"path": "sorted.txt", "equals_file": "expected/sorted.txt"})[0]
        (workspace / "sorted.txt").write_bytes(b"1\n2\n-3\n")
        assert not fs(workspace, fixture_dir, {"path": "sorted.txt", "equals_file": "expected/sorted.txt"})[0]

    def test_paths_cannot_escape_the_workspace(self, workspace, fixture_dir):
        assert not fs(workspace, fixture_dir, {"path": "../fx/_hidden/expected/sorted.txt", "exists": True})[0]
        assert not fs(workspace, fixture_dir, {"path": str(workspace / "config.json"), "exists": True})[0]

    def test_every_check_must_pass(self, workspace, fixture_dir):
        ok, d = fs(workspace, fixture_dir, {"path": "config.json", "exists": True}, {"path": "gone.txt", "exists": True})
        assert not ok and [c["passed"] for c in d["checks"]] == [True, False]

    def test_unsupported_check_is_a_task_error(self, workspace, fixture_dir):
        with pytest.raises(SpecProblem):
            fs(workspace, fixture_dir, {"path": "config.json", "contains": "x"})

    def test_json_path_syntax(self):
        assert json_path_get({"a": [10, 20]}, "$.a[1]") == (True, 20)
        assert json_path_get({"a": 1}, "$") == (True, {"a": 1})
        with pytest.raises(SpecProblem):
            json_path_get({}, "$..a")


def make_ctx(workspace: Path, fixture_dir: Path | None) -> TrialContext:
    return TrialContext(
        trial_id="T",
        attempt=1,
        seed=1,
        model=ModelSpec("m", "s/s", "http://x", "K", 1.0, 1.0, 1000),
        settings=Settings(("shell",), MemorySettings("off", None, None), SkillSettings(False, ()), 0.0, 5, 100, 10),
        task=TaskSpec("det-06-ini", "h", "p", str(fixture_dir) if fixture_dir else None, None),
        trial_dir=str(workspace.parent),
        workspace_dir=str(workspace),
        events_path=str(workspace.parent / "e.jsonl"),
        memory_seed=None,
    )


def make_result(final: str | None) -> HarnessRunResult:
    return HarnessRunResult(final, "completed", 1, Usage(1, 1, None, None, 1), None, None, (), ())


class TestRunGraders:
    def test_results_are_indexed_in_order(self, workspace, fixture_dir):
        graders = [
            {"type": "exact_match", "expected": "8081"},
            {"type": "file_state", "checks": [{"path": "config.json", "exists": True}]},
        ]
        results = run_graders(graders, make_ctx(workspace, fixture_dir), make_result("FINAL: 8081"))
        assert [(r.grader_index, r.grader_type, r.passed) for r in results] == [(0, "exact_match", True), (1, "file_state", True)]
        assert results[0].to_dict()["judge_model_id"] is None

    def test_a_task_authoring_error_is_a_grader_error(self, workspace, fixture_dir):
        with pytest.raises(GraderError):
            run_graders([{"type": "exact_match"}], make_ctx(workspace, fixture_dir), make_result("x"))

    def test_unimplemented_types_are_a_grader_error(self, workspace, fixture_dir):
        with pytest.raises(GraderError, match="not implemented"):
            run_graders([{"type": "llm_judge"}], make_ctx(workspace, fixture_dir), make_result("x"))

    def test_timeout_scoring_has_one_failed_row_per_grader(self):
        rows = failed_for_timeout([{"type": "exact_match"}, {"type": "file_state"}])
        assert [(r.grader_type, r.passed) for r in rows] == [("exact_match", False), ("file_state", False)]
