"""trace_check grader (DESIGN 7.3): pure over the event list, harness-blind."""
import json
from pathlib import Path

import pytest

from worker.graders import run_graders
from worker.graders.exact_match import SpecProblem
from worker.graders.trace_check import grade_trace_check
from worker.tests.test_graders import make_ctx, make_result


def call(tool: str, args: dict, harness_tool: str | None = None) -> dict:
    return {"kind": "tool_call", "call_id": "c", "step": 1, "tool": tool, "harness_tool": harness_tool or tool, "args": args}


def ok_call() -> dict:
    return {"kind": "api_call", "step": 1, "model": "m", "input_tokens": 1, "output_tokens": 1, "latency_ms": 1, "status": "ok", "http_status": 200}


def tc(events, *assertions):
    return grade_trace_check({"type": "trace_check", "assertions": list(assertions)}, events)


class TestToolCalled:
    def test_a_matching_call_passes(self):
        ok, d = tc([call("shell", {"cmd": "python lint.py --strict"})], {"kind": "tool_called", "tool": "shell", "args_regex": "--strict"})
        assert ok and d["assertions"][0]["passed"]

    def test_the_right_tool_with_the_wrong_arguments_fails(self):
        """The mem-05 negative: the agent ran the lint, but without the flag memory supplies."""
        ok, d = tc([call("shell", {"cmd": "python lint.py"})], {"kind": "tool_called", "tool": "shell", "args_regex": "--strict"})
        assert not ok and "0 of 1" in d["assertions"][0]["reason"]

    def test_the_right_arguments_on_the_wrong_tool_fail(self):
        ok, _ = tc([call("files", {"path": "--strict"})], {"kind": "tool_called", "tool": "shell", "args_regex": "--strict"})
        assert not ok

    def test_without_a_regex_any_call_of_the_tool_counts(self):
        assert tc([call("shell", {"cmd": "ls"})], {"kind": "tool_called", "tool": "shell"})[0]
        assert not tc([], {"kind": "tool_called", "tool": "shell"})[0]

    def test_the_regex_is_searched_not_anchored(self):
        assert tc([call("shell", {"cmd": "cd x && python lint.py --strict && echo"})], {"kind": "tool_called", "tool": "shell", "args_regex": "lint\\.py --strict"})[0]

    def test_one_matching_call_among_many_is_enough(self):
        events = [call("shell", {"cmd": "ls"}), call("shell", {"cmd": "python lint.py --strict"}), call("files", {"path": "a"})]
        assert tc(events, {"kind": "tool_called", "tool": "shell", "args_regex": "--strict"})[0]

    def test_a_harness_with_its_own_tool_name_is_matched_by_the_platform_name(self):
        """Hermes calls its shell tool `terminal`; the event carries tool=shell (ADAPTERS 1)."""
        event = call("shell", {"command": "python lint.py --strict"}, harness_tool="terminal")
        assert tc([event], {"kind": "tool_called", "tool": "shell", "args_regex": "--strict"})[0]


class TestToolNotCalled:
    def test_passes_when_absent_and_fails_when_present(self):
        assert tc([call("files", {"path": "a"})], {"kind": "tool_not_called", "tool": "shell"})[0]
        assert not tc([call("shell", {"cmd": "ls"})], {"kind": "tool_not_called", "tool": "shell"})[0]

    def test_other_event_kinds_are_not_calls(self):
        assert tc([{"kind": "tool_result", "tool": "shell", "output": "x"}, ok_call()], {"kind": "tool_not_called", "tool": "shell"})[0]


class TestMaxSteps:
    @pytest.mark.parametrize("n,limit,expected", [(3, 3, True), (4, 3, False), (0, 0, True), (1, 0, False)])
    def test_boundary(self, n, limit, expected):
        assert tc([ok_call()] * n, {"kind": "max_steps", "value": limit})[0] is expected

    def test_failed_and_retried_requests_are_not_steps(self):
        retry = {**ok_call(), "status": "retry", "http_status": 429}
        assert tc([retry, retry, ok_call()], {"kind": "max_steps", "value": 1})[0]


class TestCombination:
    def test_every_assertion_must_hold(self):
        events = [call("shell", {"cmd": "python lint.py --strict"}), ok_call()]
        both = ({"kind": "tool_called", "tool": "shell", "args_regex": "--strict"}, {"kind": "max_steps", "value": 1})
        assert tc(events, *both)[0]
        assert not tc(events + [ok_call()], *both)[0]

    def test_details_list_each_assertion(self):
        _, d = tc([], {"kind": "tool_called", "tool": "shell"}, {"kind": "tool_not_called", "tool": "files"})
        assert [a["passed"] for a in d["assertions"]] == [False, True]


class TestSpecProblems:
    @pytest.mark.parametrize(
        "assertion",
        [
            {"kind": "bogus"},
            {"kind": "tool_called"},
            {"kind": "tool_called", "tool": "shell", "args_regex": "("},
            {"kind": "max_steps", "value": -1},
            {"kind": "max_steps", "value": "3"},
            {"kind": "max_steps", "value": True},
        ],
    )
    def test_a_malformed_assertion_is_a_task_error(self, assertion):
        with pytest.raises(SpecProblem):
            tc([], assertion)

    def test_no_assertions_is_a_task_error(self):
        with pytest.raises(SpecProblem):
            grade_trace_check({"type": "trace_check", "assertions": []}, [])


def test_run_graders_reads_the_events_from_disk(tmp_path: Path):
    ws = tmp_path / "ws"
    ws.mkdir()
    ctx = make_ctx(ws, None)
    Path(ctx.events_path).write_text(json.dumps(call("shell", {"cmd": "python lint.py --strict"})) + "\n" + '{"kind": "tool_call", "to', encoding="utf-8")
    spec = [{"type": "trace_check", "assertions": [{"kind": "tool_called", "tool": "shell", "args_regex": "--strict"}]}]
    (result,) = run_graders(spec, ctx, make_result("FINAL: FAIL"))  # a line cut short by a kill is skipped
    assert result.grader_type == "trace_check" and result.passed
