"""llm_judge grader (DESIGN 8.1): prompt building and verdict parsing are pure; the call is tested
against the stub's scripted judge scenarios, so the tests check the grader's rules, not a model."""
import hashlib
import json
from pathlib import Path

import pytest

from worker.adapters.base import ModelSpec
from worker.graders import GraderError, failed_for_timeout, run_graders
from worker.graders import llm_judge as lj
from worker.graders.exact_match import SpecProblem
from worker.graders.llm_judge import (
    JUDGE_PROMPT_HASH,
    JudgeError,
    VerdictError,
    build_prompt,
    decide,
    grade_llm_judge,
    parse_verdict,
    render_inputs,
)
from worker.runner import run_trial
from worker.spec import SpecError, parse_trial_spec
from worker.tests.conftest import KEY_ENV, SENTINEL_KEY, make_spec, write_task
from worker.tests.test_graders import make_ctx, make_result

# Pinned on purpose. The template is frozen before any trial runs (DESIGN 8.2); changing a byte
# means a new prompt version, a new hash on every result and a new judge validation. Edit this
# constant only together with a new file name.
PINNED_V1_HASH = "931d22859676a58fd021856e094109ce06b40399921af7bcb84534875f68b019"

RUBRIC = [
    {"id": "c1", "criterion": "Names the root cause."},
    {"id": "c2", "criterion": "Names the fix."},
    {"id": "c3", "criterion": "Uses at most 5 bullets."},
]
SPEC = {"type": "llm_judge", "rubric": RUBRIC, "pass_rule": "all", "inputs": ["final_response"], "judge_model_id": None}


@pytest.fixture(autouse=True)
def _key(monkeypatch):
    monkeypatch.setenv(KEY_ENV, SENTINEL_KEY)
    monkeypatch.setattr(lj.time, "sleep", lambda s: None)


def judge_model(stub, scenario: str) -> ModelSpec:
    return ModelSpec("judge", f"stub/{scenario}", stub.base_url, KEY_ENV, 0.1, 0.5, 100000)


def judge(stub, scenario: str, final: str | None = "- root cause: X\n- fix: Y", workspace: str = ".", spec=SPEC):
    return grade_llm_judge(spec, "Summarize the incident.", final, workspace, judge_model(stub, scenario))


def judge_requests(stub, scenario: str) -> list[dict]:
    return [r for r in stub.requests if r["body"].get("model") == f"stub/{scenario}"]


# ------------------------------------------------------------------ the template


def test_the_template_hash_is_pinned_to_v1():
    assert JUDGE_PROMPT_HASH == PINNED_V1_HASH
    raw = Path(lj.PROMPT_PATH).read_bytes().replace(b"\r\n", b"\n")
    assert hashlib.sha256(raw).hexdigest() == PINNED_V1_HASH
    assert lj.PROMPT_PATH.name == "judge_prompt_v1.txt"


# ------------------------------------------------------------------ the prompt (pure)


class TestPrompt:
    def test_it_carries_the_task_the_rubric_and_the_output_and_nothing_else(self):
        prompt = build_prompt("Summarize the incident.", RUBRIC, [("final_response", "THE-OUTPUT")])
        assert "Summarize the incident." in prompt
        assert "1. [c1] Names the root cause." in prompt and "3. [c3] Uses at most 5 bullets." in prompt
        assert '<output name="final_response">\nTHE-OUTPUT\n</output>' in prompt
        assert "{{" not in prompt and "trajectory" not in prompt.lower()

    def test_text_that_looks_like_a_placeholder_in_the_output_is_not_substituted(self):
        prompt = build_prompt("task", RUBRIC, [("final_response", "{{rubric}} and {{task_prompt}}")])
        assert "{{rubric}} and {{task_prompt}}" in prompt

    def test_a_workspace_file_is_read_and_a_missing_one_is_stated(self, tmp_path):
        (tmp_path / "RELEASE.md").write_text("1. bump VERSION", encoding="utf-8")
        got = render_inputs(["final_response", "workspace_file:RELEASE.md", "workspace_file:NOPE.md"], "done", str(tmp_path))
        assert got[0] == ("final_response", "done")
        assert got[1] == ("workspace_file:RELEASE.md", "1. bump VERSION")
        assert "does not exist" in got[2][1]

    def test_no_final_response_is_stated(self, tmp_path):
        assert "no final response" in render_inputs(["final_response"], None, str(tmp_path))[0][1]

    def test_a_long_input_is_cut(self, tmp_path):
        text = render_inputs(["final_response"], "z" * (lj.MAX_INPUT_CHARS + 50), str(tmp_path))[0][1]
        assert len(text) < lj.MAX_INPUT_CHARS + 100 and "cut at" in text

    @pytest.mark.parametrize("name", ["workspace_file:../secret.txt", "workspace_file:", "trajectory", "workspace_file:/etc/passwd"])
    def test_an_input_outside_the_workspace_or_unknown_is_a_task_error(self, tmp_path, name):
        with pytest.raises(SpecProblem):
            render_inputs([name], "x", str(tmp_path))


# ------------------------------------------------------------------ the verdict (pure)


def verdict(met=(True, True, True), model_pass=True, ids=("c1", "c2", "c3"), reasoning="because"):
    return json.dumps({"criteria": [{"id": i, "met": m, "evidence": f"e{i}"} for i, m in zip(ids, met)], "pass": model_pass, "reasoning": reasoning})


class TestVerdict:
    IDS = ["c1", "c2", "c3"]

    def test_a_clean_reply(self):
        v = parse_verdict(verdict(), self.IDS)
        assert [c["met"] for c in v.criteria] == [True] * 3 and v.model_pass is True and v.reasoning == "because"

    def test_a_fence_or_prose_around_the_object_is_tolerated(self):
        assert parse_verdict("Sure!\n```json\n" + verdict() + "\n```\nDone.", self.IDS).model_pass is True

    def test_criteria_come_back_in_rubric_order(self):
        reply = json.dumps({"criteria": [{"id": i, "met": True} for i in ("c3", "c1", "c2")], "pass": True, "reasoning": ""})
        assert [c["id"] for c in parse_verdict(reply, self.IDS).criteria] == self.IDS

    @pytest.mark.parametrize(
        "reply",
        [
            "no json here",
            "[1, 2, 3]",
            json.dumps({"pass": True}),
            json.dumps({"criteria": [{"id": "c1", "met": True}, {"id": "c2", "met": True}], "pass": True}),
            json.dumps({"criteria": [{"id": "c1", "met": True}, {"id": "c1", "met": True}, {"id": "c2", "met": True}], "pass": True}),
            json.dumps({"criteria": [{"id": i, "met": True} for i in ("c1", "c2", "c3", "c4")], "pass": True}),
            json.dumps({"criteria": [{"id": "c1", "met": "true"}, {"id": "c2", "met": True}, {"id": "c3", "met": True}], "pass": True}),
            json.dumps({"criteria": [{"id": "c1"}, {"id": "c2", "met": True}, {"id": "c3", "met": True}], "pass": True}),
        ],
    )
    def test_a_reply_that_does_not_cover_the_rubric_exactly_is_refused(self, reply):
        with pytest.raises(VerdictError):
            parse_verdict(reply, self.IDS)

    def test_pass_is_recomputed_from_the_criteria(self):
        v = parse_verdict(verdict(met=(True, False, True), model_pass=True), self.IDS)
        assert v.model_pass is True and decide("all", v.criteria) is False

    def test_an_unknown_pass_rule_is_a_task_error(self):
        with pytest.raises(SpecProblem):
            decide("most", [])


# ------------------------------------------------------------------ against the scripted judge


class TestAgainstTheStub:
    def test_a_pass(self, stub):
        out = judge(stub, "judge_pass")
        assert out.passed and out.reasoning == "scripted: every criterion is met"
        assert [c["met"] for c in out.details["criteria"]] == [True, True, True]
        assert out.details["attempts"] == 1 and out.details["response_format"] == "json_object"

    def test_a_fail(self, stub):
        out = judge(stub, "judge_fail")
        assert not out.passed and out.details["criteria"][0]["met"] is False and out.details["model_pass"] is False

    def test_the_models_own_pass_is_stored_and_not_trusted(self, stub):
        out = judge(stub, "judge_lying_pass")
        assert out.details["model_pass"] is True and out.passed is False

    def test_a_reply_without_json_is_sent_back_once_with_the_reason(self, stub):
        out = judge(stub, "judge_garbage_then_pass")
        assert out.passed and out.details["attempts"] == 2
        first, second = judge_requests(stub, "judge_garbage_then_pass")[-2:]
        assert [m["role"] for m in second["body"]["messages"]] == ["user", "assistant", "user"]
        assert "no JSON object" in second["body"]["messages"][-1]["content"]
        assert len(first["body"]["messages"]) == 1

    def test_wrong_criterion_ids_are_sent_back_once(self, stub):
        out = judge(stub, "judge_wrong_ids_then_pass")
        assert out.passed and out.details["attempts"] == 2

    def test_two_unusable_replies_raise(self, stub):
        with pytest.raises(JudgeError, match="no usable verdict after 2 tries"):
            judge(stub, "judge_garbage")
        assert len(judge_requests(stub, "judge_garbage")) == 2

    def test_a_fenced_reply_is_parsed(self, stub):
        assert judge(stub, "judge_fenced").passed

    def test_json_mode_is_tried_first_and_dropped_on_http_400(self, stub):
        before = len(judge_requests(stub, "judge_no_json_mode"))
        out = judge(stub, "judge_no_json_mode")
        sent = judge_requests(stub, "judge_no_json_mode")[before:]
        assert out.passed and out.details["response_format"] == "plain"
        assert "response_format" in sent[0]["body"] and "response_format" not in sent[1]["body"]

    def test_a_429_is_retried_without_counting_as_a_parse_failure(self, stub):
        out = judge(stub, "judge_429_once")
        assert out.passed and out.details["attempts"] == 1

    def test_the_request_is_deterministic_and_carries_no_trajectory(self, stub):
        judge(stub, "judge_pass", final="UNIQUE-FINAL-TEXT")
        body = judge_requests(stub, "judge_pass")[-1]["body"]
        assert body["temperature"] == 0 and body["response_format"] == {"type": "json_object"}
        assert len(body["messages"]) == 1 and body["messages"][0]["role"] == "user"
        content = body["messages"][0]["content"]
        assert "UNIQUE-FINAL-TEXT" in content and "Summarize the incident." in content and "Names the fix." in content
        assert "tools" not in body

    def test_usage_is_recorded_for_cost(self, stub):
        out = judge(stub, "judge_garbage_then_pass")
        assert out.details["usage"]["input_tokens"] > 0 and out.details["usage"]["output_tokens"] > 0

    def test_an_input_file_in_the_workspace_reaches_the_judge(self, stub, tmp_path):
        (tmp_path / "RELEASE.md").write_text("FILE-BODY-123", encoding="utf-8")
        spec = {**SPEC, "inputs": ["workspace_file:RELEASE.md"]}
        judge(stub, "judge_pass", workspace=str(tmp_path), spec=spec)
        assert "FILE-BODY-123" in judge_requests(stub, "judge_pass")[-1]["body"]["messages"][0]["content"]

    def test_a_judge_model_the_task_does_not_name_is_a_task_error(self, stub):
        with pytest.raises(SpecProblem, match="names judge model"):
            judge(stub, "judge_pass", spec={**SPEC, "judge_model_id": "someone-else"})

    @pytest.mark.parametrize("over", [{"rubric": []}, {"inputs": []}, {"pass_rule": "most"}, {"rubric": [RUBRIC[0], RUBRIC[0]]}])
    def test_a_malformed_spec_costs_nothing(self, stub, over):
        before = len(stub.requests)
        with pytest.raises(SpecProblem):
            judge(stub, "judge_pass", spec={**SPEC, **over})
        assert len(stub.requests) == before


# ------------------------------------------------------------------ inside run_graders and the runner


class TestWiring:
    def test_the_result_carries_reasoning_and_the_judge_ids(self, stub, tmp_path):
        ws = tmp_path / "ws"
        ws.mkdir()
        graders = [{"type": "exact_match", "expected": "8081"}, SPEC]
        results = run_graders(graders, make_ctx(ws, None), make_result("FINAL: 8081"), judge_model(stub, "judge_pass"))
        assert [r.passed for r in results] == [True, True]
        d = results[1].to_dict()
        assert d["reasoning"] == "scripted: every criterion is met"
        assert (d["judge_model_id"], d["judge_prompt_hash"]) == ("judge", JUDGE_PROMPT_HASH)
        assert results[0].judge_model_id is None and results[0].reasoning is None

    def test_a_failing_judge_fails_the_trial_even_when_the_other_graders_pass(self, stub, tmp_path):
        ws = tmp_path / "ws"
        ws.mkdir()
        results = run_graders([{"type": "exact_match", "expected": "8081"}, SPEC], make_ctx(ws, None), make_result("FINAL: 8081"), judge_model(stub, "judge_fail"))
        assert not all(r.passed for r in results)

    def test_a_judge_that_cannot_answer_is_a_grader_error(self, stub, tmp_path):
        ws = tmp_path / "ws"
        ws.mkdir()
        with pytest.raises(GraderError):
            run_graders([SPEC], make_ctx(ws, None), make_result("x"), judge_model(stub, "judge_garbage"))

    def test_no_judge_model_is_a_grader_error(self, tmp_path):
        ws = tmp_path / "ws"
        ws.mkdir()
        with pytest.raises(GraderError, match="no judge model"):
            run_graders([SPEC], make_ctx(ws, None), make_result("x"), None)

    def test_a_killed_trial_gets_judge_ids_on_its_synthesized_row(self, stub):
        rows = failed_for_timeout([{"type": "exact_match"}, SPEC], judge_model(stub, "judge_pass"))
        assert rows[0].judge_model_id is None and rows[0].judge_prompt_hash is None
        assert rows[1].judge_model_id == "judge" and rows[1].judge_prompt_hash == JUDGE_PROMPT_HASH and not rows[1].passed

    def test_the_spec_must_carry_a_judge_model_when_a_grader_needs_one(self, runner_env):
        write_task(runner_env.tasks_dir, "jdg-01-x", None, [SPEC], "Summarize.")
        spec = make_spec(runner_env.tasks_dir, task_id="jdg-01-x")
        with pytest.raises(SpecError, match="judge_model is required"):
            parse_trial_spec(spec)
        result = run_trial(spec, runner_env)
        assert result["status"] == "errored" and result["error_class"] == "config_invalid"

    def test_a_full_trial_through_the_runner_is_judged_and_scrubbed(self, stub, runner_env):
        write_task(runner_env.tasks_dir, "jdg-01-x", None, [SPEC], "Summarize.")
        spec = make_spec(runner_env.tasks_dir, task_id="jdg-01-x")
        spec["judge_model"] = {**spec["model"], "id": "judge", "slug": "stub/judge_pass", "base_url": stub.base_url}
        result = run_trial(spec, runner_env)
        assert result["status"] == "done" and result["passed"] is True
        (g,) = result["grader_results"]
        assert g["grader_type"] == "llm_judge" and g["judge_model_id"] == "judge" and g["judge_prompt_hash"] == JUDGE_PROMPT_HASH
        assert g["reasoning"] and SENTINEL_KEY not in json.dumps(result)

    def test_a_timed_out_trial_keeps_the_judge_ids(self, stub, runner_env):
        write_task(runner_env.tasks_dir, "jdg-01-x", None, [SPEC], "Summarize.")
        spec = make_spec(runner_env.tasks_dir, task_id="jdg-01-x", mode="stall", timeout=1)
        spec["judge_model"] = {**spec["model"], "id": "judge", "slug": "stub/judge_pass", "base_url": stub.base_url}
        result = run_trial(spec, runner_env)
        assert result["outcome"]["exit_reason"] == "timeout" and result["passed"] is False
        assert result["grader_results"][0]["judge_model_id"] == "judge"
