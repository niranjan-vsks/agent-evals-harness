"""llm_judge grader (DESIGN 8.1).

{"type":"llm_judge", "rubric":[{"id":"c1","criterion":"..."}], "pass_rule":"all",
 "inputs":["final_response","workspace_file:RELEASE.md"], "judge_model_id":null}

The judge sees the task prompt, the rubric and the declared inputs, never the trajectory. It
replies with JSON at temperature 0. `pass` is recomputed here from the per-criterion verdicts
under pass_rule; the model's own `pass` is kept in the details and not trusted. A reply that
does not parse, or does not cover the rubric exactly, is sent back once with the reason; a second
failure raises JudgeError (a grader_error, DESIGN 6.3). Reasoning is stored verbatim.

The prompt builder and the verdict parser are pure and tested without a network. The call goes
through worker.models.make_client like every other model call.
"""
import hashlib
import json
import re
import time
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    import openai

from worker.adapters.base import ModelSpec
from worker.graders.exact_match import SpecProblem
from worker.models import make_client

PROMPT_PATH = Path(__file__).with_name("judge_prompt_v1.txt")
MAX_INPUT_CHARS = 20_000
MAX_TOKENS = 2048
TRANSIENT_BACKOFF_SECONDS = (1, 2, 4)
REQUEST_TIMEOUT_SECONDS = 60.0
DEADLINE_SECONDS = 150.0  # all of one judge call's requests and waits; grading shares the trial's wall clock
_PLACEHOLDER = re.compile(r"\{\{(\w+)\}\}")


def _template() -> str:
    return PROMPT_PATH.read_text(encoding="utf-8").replace("\r\n", "\n")


def prompt_hash() -> str:
    """sha256 of the template text with LF line endings: the id recorded on every result."""
    return hashlib.sha256(_template().encode("utf-8")).hexdigest()


JUDGE_PROMPT_HASH = prompt_hash()


class JudgeError(RuntimeError):
    """The judge could not give a usable verdict. Maps to error_class grader_error."""


class VerdictError(ValueError):
    """The judge's reply is not a usable verdict; the message says why and goes back to the judge."""


# ------------------------------------------------------------------ pure: prompt


def render_inputs(inputs: list[str], final_response: str | None, workspace_dir: str) -> list[tuple[str, str]]:
    """(name, text) per declared input, in order. A missing file or response is stated, not skipped."""
    out: list[tuple[str, str]] = []
    root = Path(workspace_dir).resolve()
    for name in inputs:
        if name == "final_response":
            text = final_response if final_response is not None else "(the agent produced no final response)"
        elif name.startswith("workspace_file:"):
            rel = name[len("workspace_file:"):]
            target = (root / rel).resolve()
            if not rel or (target != root and root not in target.parents):
                raise SpecProblem(f"llm_judge input {name!r} is outside the workspace")
            text = target.read_text(encoding="utf-8", errors="replace") if target.is_file() else "(the file does not exist in the workspace)"
        else:
            raise SpecProblem(f"unknown llm_judge input {name!r}")
        if len(text) > MAX_INPUT_CHARS:
            text = text[:MAX_INPUT_CHARS] + f"\n[cut at {MAX_INPUT_CHARS} characters]"
        out.append((name, text))
    return out


def _defang(text: str) -> str:
    """The agent's text cannot close its own <output> block and write sections of the prompt after it."""
    return re.sub(r"<(/?)output", r"<\1 output", text)


def build_prompt(task_prompt: str, rubric: list[dict[str, str]], rendered_inputs: list[tuple[str, str]]) -> str:
    rubric_text = "\n".join(f"{i}. [{c['id']}] {c['criterion']}" for i, c in enumerate(rubric, start=1))
    inputs_text = "\n\n".join(f'<output name="{name}">\n{_defang(text)}\n</output>' for name, text in rendered_inputs)
    values = {"task_prompt": task_prompt, "rubric": rubric_text, "inputs": inputs_text}
    # One pass, so a placeholder-looking string inside the agent's output is not substituted again.
    return _PLACEHOLDER.sub(lambda m: values[m.group(1)], _template())


# ------------------------------------------------------------------ pure: verdict


def extract_json_object(text: str) -> Any:
    """The first JSON object in text: the whole reply, or inside a fence or after some prose."""
    decoder = json.JSONDecoder()
    for m in re.finditer(r"\{", text):
        try:
            value, _ = decoder.raw_decode(text, m.start())
        except ValueError:
            continue
        if isinstance(value, dict):
            return value
    raise VerdictError("the reply contains no JSON object")


@dataclass(frozen=True)
class Verdict:
    criteria: list[dict[str, Any]]
    model_pass: bool | None
    reasoning: str


def parse_verdict(text: str, rubric_ids: list[str]) -> Verdict:
    data = extract_json_object(text)
    criteria = data.get("criteria")
    if not isinstance(criteria, list) or not all(isinstance(c, dict) for c in criteria):
        raise VerdictError('"criteria" must be an array of objects')
    seen = [c.get("id") for c in criteria]
    if sorted(map(str, seen)) != sorted(rubric_ids) or len(set(map(str, seen))) != len(seen):
        raise VerdictError(f"the criteria ids must be exactly {rubric_ids}, each once; got {seen}")
    by_id = {c["id"]: c for c in criteria}
    ordered = []
    for cid in rubric_ids:
        met = by_id[cid].get("met")
        if not isinstance(met, bool):
            raise VerdictError(f'criterion {cid}: "met" must be true or false, got {met!r}')
        evidence = by_id[cid].get("evidence")
        ordered.append({"id": cid, "met": met, "evidence": evidence if isinstance(evidence, str) else ""})
    model_pass = data.get("pass")
    reasoning = data.get("reasoning")
    return Verdict(ordered, model_pass if isinstance(model_pass, bool) else None, reasoning if isinstance(reasoning, str) else "")


def decide(pass_rule: str, criteria: list[dict[str, Any]]) -> bool:
    if pass_rule != "all":
        raise SpecProblem(f"unknown pass_rule {pass_rule!r}")
    return all(c["met"] for c in criteria)


# ------------------------------------------------------------------ the call


class _Conversation:
    """One judge call with its transient-error retries and the json_object fallback."""

    def __init__(self, client: "openai.OpenAI", model: ModelSpec):
        self.client, self.model = client, model
        self.json_mode = True
        self.input_tokens = 0
        self.output_tokens = 0
        self.started = time.monotonic()

    def complete(self, messages: list[dict[str, str]]) -> str:
        import openai  # noqa: PLC0415 - only a judge call needs it

        for attempt in range(len(TRANSIENT_BACKOFF_SECONDS) + 1):
            if time.monotonic() - self.started > DEADLINE_SECONDS:
                raise JudgeError(f"the judge model did not answer within {int(DEADLINE_SECONDS)} seconds")
            kwargs: dict[str, Any] = {"model": self.model.slug, "messages": messages, "temperature": 0, "max_tokens": MAX_TOKENS}
            if self.json_mode:
                kwargs["response_format"] = {"type": "json_object"}
            try:
                resp = self.client.with_options(timeout=REQUEST_TIMEOUT_SECONDS).chat.completions.create(**kwargs)
            except openai.APIStatusError as e:
                if e.status_code == 400 and self.json_mode:
                    self.json_mode = False  # the provider or model refuses json_object: ask in plain words
                    return self.complete(messages)
                if (e.status_code == 429 or e.status_code >= 500) and attempt < len(TRANSIENT_BACKOFF_SECONDS):
                    time.sleep(TRANSIENT_BACKOFF_SECONDS[attempt])
                    continue
                raise JudgeError(f"the judge model returned HTTP {e.status_code}: {e.message}") from e
            except openai.APIConnectionError as e:
                if attempt < len(TRANSIENT_BACKOFF_SECONDS):
                    time.sleep(TRANSIENT_BACKOFF_SECONDS[attempt])
                    continue
                raise JudgeError(f"the judge model could not be reached: {type(e).__name__}") from e
            usage = getattr(resp, "usage", None)
            self.input_tokens += int(getattr(usage, "prompt_tokens", 0) or 0)
            self.output_tokens += int(getattr(usage, "completion_tokens", 0) or 0)
            if not resp.choices or not isinstance(resp.choices[0].message.content, str):
                raise JudgeError("the judge model returned no message content")
            return resp.choices[0].message.content
        raise AssertionError("unreachable")


@dataclass(frozen=True)
class JudgeOutcome:
    passed: bool
    details: dict[str, Any]
    reasoning: str


def grade_llm_judge(
    spec: dict[str, Any],
    task_prompt: str,
    final_response: str | None,
    workspace_dir: str,
    judge_model: ModelSpec,
    client: "openai.OpenAI | None" = None,
) -> JudgeOutcome:
    rubric = spec.get("rubric")
    inputs = spec.get("inputs")
    if not isinstance(rubric, list) or not rubric or not all(isinstance(c, dict) and isinstance(c.get("id"), str) and isinstance(c.get("criterion"), str) for c in rubric):
        raise SpecProblem("llm_judge needs a rubric of {id, criterion} objects")
    if not isinstance(inputs, list) or not inputs:
        raise SpecProblem("llm_judge needs a non-empty inputs array")
    pass_rule = spec.get("pass_rule", "all")
    wanted = spec.get("judge_model_id")
    if wanted is not None and wanted != judge_model.id:
        raise SpecProblem(f"the task names judge model {wanted!r} but the trial carries {judge_model.id!r}")
    rubric_ids = [c["id"] for c in rubric]
    if len(set(rubric_ids)) != len(rubric_ids):
        raise SpecProblem("rubric ids must be unique")
    decide(pass_rule, [])  # rejects an unknown rule before any money is spent

    rendered = render_inputs(inputs, final_response, workspace_dir)
    prompt = build_prompt(task_prompt, rubric, rendered)
    convo = _Conversation(client or make_client(judge_model), judge_model)
    messages: list[dict[str, str]] = [{"role": "user", "content": prompt}]
    verdict: Verdict | None = None
    reply = ""
    attempts = 0
    for attempts in (1, 2):
        reply = convo.complete(messages)
        try:
            verdict = parse_verdict(reply, rubric_ids)
            break
        except VerdictError as e:
            if attempts == 2:
                raise JudgeError(f"the judge gave no usable verdict after 2 tries: {e}; last reply: {reply[:500]!r}") from e
            messages = [
                *messages,
                {"role": "assistant", "content": reply},
                {"role": "user", "content": f"That reply could not be used: {e}. Reply again with the JSON object only."},
            ]
    assert verdict is not None
    passed = decide(pass_rule, verdict.criteria)
    return JudgeOutcome(
        passed=passed,
        reasoning=verdict.reasoning,
        details={
            "criteria": verdict.criteria,
            "pass_rule": pass_rule,
            "judge_model_slug": judge_model.slug,  # the registry row can change; the result records what was called
            "model_pass": verdict.model_pass,
            "attempts": attempts,
            "response_format": "json_object" if convo.json_mode else "plain",
            "usage": {"input_tokens": convo.input_tokens, "output_tokens": convo.output_tokens},
            # Exactly what the judge was shown. The workspace is deleted after the trial (R-8), and a human
            # labeller needs the same text to label blind (DESIGN 8.2), so it is kept with the verdict.
            "judged_inputs": [{"name": name, "text": text} for name, text in rendered],
            "raw_response": reply[:4000],
        },
    )
