"""Grading, called by the child process after the adapter returns (R-7)."""
import time
from dataclasses import dataclass, field
from typing import Any

from worker.adapters.base import HarnessRunResult, TrialContext
from worker.graders.exact_match import SpecProblem, grade_exact_match
from worker.graders.file_state import grade_file_state


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


def run_graders(graders: list[dict[str, Any]], ctx: TrialContext, run_result: HarnessRunResult) -> list[GraderResult]:
    results: list[GraderResult] = []
    for index, spec in enumerate(graders):
        kind = spec.get("type")
        started = time.monotonic()
        try:
            if kind == "exact_match":
                passed, details = grade_exact_match(spec, run_result.final_response)
            elif kind == "file_state":
                passed, details = grade_file_state(spec, ctx.workspace_dir, ctx.task.fixture_dir)
            else:
                raise GraderError(f"grader type {kind!r} is not implemented in P1")
        except SpecProblem as e:
            raise GraderError(f"grader {index} ({kind}): {e}") from e
        results.append(
            GraderResult(
                grader_index=index,
                grader_type=kind,
                passed=passed,
                details=details,
                duration_ms=int((time.monotonic() - started) * 1000),
            )
        )
    return results


def failed_for_timeout(graders: list[dict[str, Any]]) -> list[GraderResult]:
    """A killed trial is scored failed (R-2). One failed row per grader keeps D-14 true:
    trial.passed is the AND over grader_result.passed, and an empty AND would be true."""
    return [
        GraderResult(
            grader_index=i,
            grader_type=str(g.get("type")),
            passed=False,
            details={"skipped": "trial was killed at the wall clock limit before grading (R-2)"},
            duration_ms=0,
        )
        for i, g in enumerate(graders)
    ]
