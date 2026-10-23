"""exact_match grader. Pure given the final response (DESIGN 7.3).

{"type":"exact_match", "expected":"Marco" | ["a","b"], "expected_regex":null,
 "normalize":["trim","lowercase","collapse_whitespace"], "extract":"final_line"}

extract final_line: the last line matching ^FINAL:\\s*(.+)$ ; when there is none, the whole
response. The marker may be preceded by markdown (`**FINAL: x**`, `> FINAL: x`), and the answer is
cleaned of surrounding `*`, `_`, backticks and whitespace and of one trailing full stop, because a
correct answer in bold is still correct. The content is not loosened: no thousands separators, no
units, no other text. Normalization is applied to the extracted answer and to every expected value.
expected_regex, when set, must match the whole normalized answer.
"""
import re
from typing import Any

_FINAL = re.compile(r"^[ \t>*_`-]*FINAL:[ \t]*(.+)$", re.MULTILINE)
_WRAP = " \t*_`"
_NORMALIZERS = {
    "trim": lambda s: s.strip(),
    "lowercase": lambda s: s.lower(),
    "collapse_whitespace": lambda s: re.sub(r"\s+", " ", s),
}


class SpecProblem(ValueError):
    """The grader spec itself is wrong (a task authoring error, not an agent failure)."""


def _normalize(value: str, ops: list[str]) -> str:
    for op in ops:
        if op not in _NORMALIZERS:
            raise SpecProblem(f"unknown normalize op {op!r}")
        value = _NORMALIZERS[op](value)
    return value


def extract_answer(response: str, mode: str) -> tuple[str, bool]:
    """Returns (answer, used_fallback)."""
    if mode != "final_line":
        raise SpecProblem(f"unknown extract mode {mode!r}")
    matches = _FINAL.findall(response)
    if matches:
        return _clean(matches[-1]), False
    return response, True


def _clean(answer: str) -> str:
    answer = answer.rstrip("\r").strip(_WRAP)
    if answer.endswith(".") and not answer.endswith(".."):
        answer = answer[:-1].strip(_WRAP)
    return answer


def grade_exact_match(spec: dict[str, Any], final_response: str | None) -> tuple[bool, dict[str, Any]]:
    expected = spec.get("expected")
    expected_regex = spec.get("expected_regex")
    if expected is None and expected_regex is None:
        raise SpecProblem("exact_match needs expected or expected_regex")
    if expected_regex is not None:
        try:
            re.compile(expected_regex)
        except (re.error, TypeError) as e:
            raise SpecProblem(f"expected_regex {expected_regex!r} is not a valid regular expression: {e}") from e
    ops = list(spec.get("normalize", ["trim"]))
    mode = spec.get("extract", "final_line")
    if final_response is None:
        return False, {"reason": "no final response", "expected": expected, "extracted": None}
    answer, fallback = extract_answer(final_response, mode)
    got = _normalize(answer, ops)
    details: dict[str, Any] = {"extracted": answer, "normalized": got, "used_fallback": fallback, "expected": expected}
    passed = False
    if expected is not None:
        wanted = [expected] if isinstance(expected, str) else list(expected)
        passed = got in [_normalize(w, ops) for w in wanted]
    if not passed and expected_regex is not None:
        details["expected_regex"] = expected_regex
        passed = re.fullmatch(expected_regex, got) is not None
    return passed, details
