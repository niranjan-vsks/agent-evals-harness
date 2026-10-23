"""Grading, called by the child process after the adapter returns (R-7)."""
import time
from dataclasses import dataclass, field
from typing import Any

from worker.adapters.base import HarnessRunResult, ModelSpec, TrialContext
from worker.graders.exact_match import SpecProblem, grade_exact_match
from worker.graders.file_state import grade_file_state
from worker.graders.llm_judge import JUDGE_PROMPT_HASH, JudgeError, grade_llm_judge
from worker.graders.trace_check import grade_trace_check
from worker.graders.unit_test import grade_unit_test
from worker.trace import read_events


class GraderError(RuntimeError):
    """A grader could not run (bad spec, unimplemented type). Maps to error_class grader_error."""


@dataclass(frozen=True)
class GraderResult:
    grader_index: int
    grader_type: str
    passed: bool
    details: dict[str, Any]
    duration_ms: int
    reasoning: str | None = None
    judge_model_id: str | None = None
    judge_prompt_hash: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "grader_index": self.grader_index,
            "grader_type": self.grader_type,
            "passed": self.passed,
            "details": self.details,
            "reasoning": self.reasoning,
            "judge_model_id": self.judge_model_id,
            "judge_prompt_hash": self.judge_prompt_hash,
            "duration_ms": self.duration_ms,
        }


def run_graders(
    graders: list[dict[str, Any]], ctx: TrialContext, run_result: HarnessRunResult, judge_model: ModelSpec | None = None
) -> list[GraderResult]:
    results: list[GraderResult] = []
    for index, spec in enumerate(graders):
        kind = spec.get("type")
        started = time.monotonic()
        reasoning: str | None = None
        judge_ids: dict[str, str | None] = {}
        try:
            if kind == "exact_match":
                passed, details = grade_exact_match(spec, run_result.final_response)
            elif kind == "file_state":
                passed, details = grade_file_state(spec, ctx.workspace_dir, ctx.task.fixture_dir)
            elif kind == "unit_test":
                passed, details = grade_unit_test(spec, ctx.workspace_dir, ctx.task.fixture_dir)
            elif kind == "trace_check":
                passed, details = grade_trace_check(spec, read_events(ctx.events_path))  # from disk, as the runner does (R-4)
            elif kind == "llm_judge":
                if judge_model is None:
                    raise GraderError(f"grader {index} (llm_judge): the trial carries no judge model")
                outcome = grade_llm_judge(spec, ctx.task.prompt, run_result.final_response, ctx.workspace_dir, judge_model)
                passed, details, reasoning = outcome.passed, outcome.details, outcome.reasoning
                judge_ids = {"judge_model_id": judge_model.id, "judge_prompt_hash": JUDGE_PROMPT_HASH}
            else:
                raise GraderError(f"grader type {kind!r} is not implemented")
        except (SpecProblem, JudgeError) as e:
            raise GraderError(f"grader {index} ({kind}): {e}") from e
        results.append(
            GraderResult(
                grader_index=index,
                grader_type=kind,
                passed=passed,
                details=details,
                duration_ms=int((time.monotonic() - started) * 1000),
                reasoning=reasoning,
                **judge_ids,
            )
        )
    return results


def failed_for_timeout(graders: list[dict[str, Any]], judge_model: ModelSpec | None = None) -> list[GraderResult]:
    """A killed trial is scored failed (R-2). One failed row per grader keeps D-14 true:
    trial.passed is the AND over grader_result.passed, and an empty AND would be true. An
    llm_judge row carries the judge ids the schema requires, though no judge was called."""
    return [
        GraderResult(
            grader_index=i,
            grader_type=str(g.get("type")),
            passed=False,
            details={"skipped": "trial was killed at the wall clock limit before grading (R-2)"},
            duration_ms=0,
            judge_model_id=(judge_model.id if judge_model else "unknown") if g.get("type") == "llm_judge" else None,
            judge_prompt_hash=JUDGE_PROMPT_HASH if g.get("type") == "llm_judge" else None,
        )
        for i, g in enumerate(graders)
    ]
