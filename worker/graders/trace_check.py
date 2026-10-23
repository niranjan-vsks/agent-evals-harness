"""trace_check grader. Pure over the trace event list (DESIGN 7.3).

{"type":"trace_check", "assertions":[
   {"kind":"tool_called","tool":"shell","args_regex":"--strict"},
   {"kind":"tool_not_called","tool":"shell"},
   {"kind":"max_steps","value":10}]}

`tool` is the platform name (shell, files) or, for a harness tool with no platform name, the
harness's own (ADAPTERS 1). `args_regex` is searched in json.dumps(args) of each matching call.
max_steps counts api_call events with status ok, the same definition as H-9. All assertions
must hold. The grader reads events only: it cannot tell which harness produced them.
"""
import json
import re
from typing import Any

from worker.graders.exact_match import SpecProblem


def _tool_calls(events: list[dict[str, Any]], tool: str) -> list[dict[str, Any]]:
    return [e for e in events if e.get("kind") == "tool_call" and e.get("tool") == tool]


def _check(assertion: dict[str, Any], events: list[dict[str, Any]]) -> tuple[bool, str]:
    kind = assertion.get("kind")
    if kind in ("tool_called", "tool_not_called"):
        tool = assertion.get("tool")
        if not isinstance(tool, str) or not tool:
            raise SpecProblem(f"{kind} needs a tool name")
        calls = _tool_calls(events, tool)
        if kind == "tool_not_called":
            return not calls, f"{len(calls)} call(s) of {tool}"
        pattern = assertion.get("args_regex")
        if pattern is None:
            return bool(calls), f"{len(calls)} call(s) of {tool}"
        try:
            rx = re.compile(pattern)
        except re.error as e:
            raise SpecProblem(f"args_regex {pattern!r} is not a valid regex: {e}") from e
        hits = [c for c in calls if rx.search(json.dumps(c.get("args", {})))]
        return bool(hits), f"{len(hits)} of {len(calls)} call(s) of {tool} match {pattern!r}"
    if kind == "max_steps":
        limit = assertion.get("value")
        if not isinstance(limit, int) or isinstance(limit, bool) or limit < 0:
            raise SpecProblem("max_steps needs a non-negative integer value")
        steps = sum(1 for e in events if e.get("kind") == "api_call" and e.get("status") == "ok")
        return steps <= limit, f"{steps} step(s), limit {limit}"
    raise SpecProblem(f"unknown trace_check assertion kind {kind!r}")


def grade_trace_check(spec: dict[str, Any], events: list[dict[str, Any]]) -> tuple[bool, dict[str, Any]]:
    assertions = spec.get("assertions")
    if not isinstance(assertions, list) or not assertions:
        raise SpecProblem("trace_check needs a non-empty assertions array")
    results = []
    for assertion in assertions:
        ok, reason = _check(assertion, events)
        results.append({"assertion": assertion, "passed": ok, "reason": reason})
    return all(r["passed"] for r in results), {"assertions": results}
