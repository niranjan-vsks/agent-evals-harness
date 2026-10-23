"""Loop-specific behaviour of the minimal loop (ADAPTERS 4). The contract itself is the conformance
suite's job; these tests drive the adapter in process against a scripted client, which makes the
retry schedule, the malformed-call counter and the path guard cheap to test."""
import copy
import hashlib
import json
import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import httpx
import openai
import pytest

from worker.adapters import REGISTRY
from worker.adapters.base import MemorySettings, ModelSpec, Settings, SkillSettings, TaskSpec, TrialContext
from worker.adapters.minimal_loop import adapter as mod
from worker.adapters.minimal_loop.prompt import PROMPT_SHA256, SYSTEM_PROMPT
from worker.trace import read_events

ADAPTER = REGISTRY["minimal_loop"]


def reply(content: str | None = None, calls: list[tuple[str, str]] | None = None, usage: tuple[int, int] = (10, 5)) -> Any:
    tool_calls = [
        SimpleNamespace(id=f"call_{i}", type="function", function=SimpleNamespace(name=n, arguments=a)) for i, (n, a) in enumerate(calls or [])
    ] or None
    return SimpleNamespace(
        choices=[SimpleNamespace(message=SimpleNamespace(content=content, tool_calls=tool_calls))],
        usage=SimpleNamespace(prompt_tokens=usage[0], completion_tokens=usage[1], prompt_tokens_details=None, completion_tokens_details=None),
    )


def call(name: str, **args: Any) -> tuple[str, str]:
    return name, json.dumps(args)


def status_error(code: int) -> openai.APIStatusError:
    request = httpx.Request("POST", "http://stub/v1/chat/completions")
    response = httpx.Response(code, request=request, json={"error": {"message": f"http {code}"}})
    cls = openai.RateLimitError if code == 429 else openai.InternalServerError if code >= 500 else openai.BadRequestError
    return cls(f"http {code}", response=response, body=None)


class ScriptedClient:
    """Stands in for openai.OpenAI: each create() pops the next scripted reply or raises it."""

    def __init__(self, script: list[Any]):
        self.script = list(script)
        self.kwargs: list[dict[str, Any]] = []
        self.chat = SimpleNamespace(completions=SimpleNamespace(create=self._create))

    def with_options(self, **_: Any) -> "ScriptedClient":
        return self

    def _create(self, **kwargs: Any) -> Any:
        self.kwargs.append(copy.deepcopy(kwargs))
        item = self.script.pop(0)
        if isinstance(item, Exception):
            raise item
        return item


def make_ctx(tmp_path: Path, *, tools: tuple[str, ...] = ("shell", "files"), max_steps: int = 15, memory_seed: dict[str, str] | None = None, seed: int = 7, temperature: float = 0.0) -> TrialContext:
    trial = tmp_path / "trial"
    (trial / "workspace").mkdir(parents=True, exist_ok=True)
    (trial / "out").mkdir(parents=True, exist_ok=True)
    return TrialContext(
        trial_id="T1",
        attempt=1,
        seed=seed,
        model=ModelSpec("m", "vendor/model", "http://stub/v1", "STUB_KEY", 1.0, 2.0, 100000),
        settings=Settings(
            tools=tools,  # type: ignore[arg-type]
            memory=MemorySettings("seeded" if memory_seed else "off", "fx" if memory_seed else None, None),
            skills=SkillSettings(False, ()),
            temperature=temperature,
            max_steps=max_steps,
            max_output_tokens=256,
            timeout_seconds=30,
            harness_options={},
        ),
        task=TaskSpec("t-01", "h", "Do the task.", None, None),
        trial_dir=str(trial),
        workspace_dir=str(trial / "workspace"),
        events_path=str(trial / "out" / "events.jsonl"),
        memory_seed=memory_seed,
    )


@pytest.fixture
def no_wait(monkeypatch):
    waits: list[float] = []
    monkeypatch.setattr(mod.time, "sleep", waits.append)
    return waits


def run(monkeypatch, ctx: TrialContext, script: list[Any]):
    client = ScriptedClient(script)
    monkeypatch.setattr(mod, "make_client", lambda spec: client)
    ADAPTER.prepare(ctx)
    result = ADAPTER.run(ctx)
    return result, read_events(ctx.events_path), client


def kinds(events: list[dict], kind: str) -> list[dict]:
    return [e for e in events if e["kind"] == kind]


# ------------------------------------------------------------------ identity


def test_the_version_carries_the_hash_of_the_fixed_system_prompt():
    assert PROMPT_SHA256 == hashlib.sha256(SYSTEM_PROMPT.encode("utf-8")).hexdigest()
    assert ADAPTER.version == f"1.0.0+{PROMPT_SHA256[:8]}"
    assert len(SYSTEM_PROMPT.splitlines()) == 6


# ------------------------------------------------------------------ malformed calls


def test_three_malformed_calls_in_a_row_end_the_trial_as_invalid_tool_call(monkeypatch, tmp_path):
    ctx = make_ctx(tmp_path)
    script = [reply(calls=[("shell", "{not valid json")]) for _ in range(5)]
    result, events, client = run(monkeypatch, ctx, script)
    assert result.exit_reason == "invalid_tool_call"
    assert result.steps == 3 and len(client.kwargs) == 3
    results = kinds(events, "tool_result")
    assert len(results) == 3 and all(r["is_error"] for r in results)
    assert "not valid JSON" in results[0]["output"]
    # The model sees its own call as an empty object in the history, so a provider accepts it.
    assistant = [m for m in client.kwargs[1]["messages"] if m["role"] == "assistant"][0]
    assert assistant["tool_calls"][0]["function"]["arguments"] == "{}"
    # The trace keeps what the model actually sent.
    assert kinds(events, "tool_call")[0]["args"] == {"raw_arguments": "{not valid json"}


def test_a_well_formed_call_resets_the_malformed_counter(monkeypatch, tmp_path):
    ctx = make_ctx(tmp_path)
    bad = reply(calls=[("shell", "oops")])
    good = reply(calls=[call("shell", cmd="echo ok")])
    script = [bad, bad, good, bad, bad, reply("FINAL: done")]
    result, _, _ = run(monkeypatch, ctx, script)
    assert result.exit_reason == "completed" and result.steps == 6


def test_a_missing_required_argument_and_an_unknown_tool_are_malformed(monkeypatch, tmp_path):
    ctx = make_ctx(tmp_path, tools=("files",))
    script = [reply(calls=[("shell", json.dumps({"cmd": "echo hi"}))]), reply(calls=[("write_file", json.dumps({"path": "a.txt"}))]), reply(calls=[("list_dir", "[]")])]
    result, events, _ = run(monkeypatch, ctx, script)
    outputs = [r["output"] for r in kinds(events, "tool_result")]
    assert "unknown tool 'shell'" in outputs[0]
    assert "'content' is required" in outputs[1]
    assert "must be a JSON object" in outputs[2]
    assert result.exit_reason == "invalid_tool_call"
    assert not (Path(ctx.workspace_dir) / "a.txt").exists()


# ------------------------------------------------------------------ tools


def test_a_path_that_leaves_the_workspace_is_an_error_result_not_a_malformed_call(monkeypatch, tmp_path):
    (tmp_path / "secret.txt").write_text("outside", encoding="utf-8")
    ctx = make_ctx(tmp_path)
    outside = str(tmp_path / "secret.txt")
    script = [
        reply(calls=[call("read_file", path="../../secret.txt")]),
        reply(calls=[call("read_file", path=outside)]),
        reply(calls=[call("write_file", path="../escape.txt", content="x")]),
        reply(calls=[call("list_dir", path="..")]),
        reply("FINAL: done"),
    ]
    result, events, _ = run(monkeypatch, ctx, script)
    results = kinds(events, "tool_result")
    assert len(results) == 4
    assert all(r["is_error"] and "outside the workspace" in r["output"] for r in results)
    assert not (tmp_path / "trial" / "escape.txt").exists()
    assert result.exit_reason == "completed"  # four failed calls are not malformed calls


def test_a_symlink_that_points_out_of_the_workspace_is_refused(monkeypatch, tmp_path):
    (tmp_path / "secret.txt").write_text("outside", encoding="utf-8")
    ctx = make_ctx(tmp_path)
    try:
        (Path(ctx.workspace_dir) / "link.txt").symlink_to(tmp_path / "secret.txt")
    except OSError:
        pytest.skip("this account cannot create symlinks")
    _, events, _ = run(monkeypatch, ctx, [reply(calls=[call("read_file", path="link.txt")]), reply("done")])
    assert kinds(events, "tool_result")[0]["is_error"]


def test_file_tools_read_write_and_list(monkeypatch, tmp_path):
    ctx = make_ctx(tmp_path)
    ws = Path(ctx.workspace_dir)
    (ws / "sub").mkdir()
    (ws / "a.txt").write_text("alpha", encoding="utf-8")
    script = [
        reply(calls=[call("write_file", path="out/new.txt", content="line1\nline2\n")]),
        reply(calls=[call("read_file", path="a.txt"), call("list_dir", path=".")]),
        reply(calls=[call("read_file", path="missing.txt")]),
        reply("FINAL: done"),
    ]
    _, events, _ = run(monkeypatch, ctx, script)
    assert (ws / "out" / "new.txt").read_bytes() == b"line1\nline2\n"  # no newline translation
    results = kinds(events, "tool_result")
    assert results[1]["output"] == "alpha"
    assert results[2]["output"].splitlines() == ["a.txt", "out/", "sub/"]
    assert results[3]["is_error"] and "FileNotFoundError" in results[3]["output"]
    assert {e["tool"] for e in kinds(events, "tool_call")} == {"files"}


def test_shell_runs_in_the_workspace_and_reports_a_failing_exit(monkeypatch, tmp_path):
    ctx = make_ctx(tmp_path)
    (Path(ctx.workspace_dir) / "marker.txt").write_text("m", encoding="utf-8")
    py = f'"{sys.executable}"'
    script = [
        reply(calls=[call("shell", cmd=f"{py} -c \"import os; print(sorted(os.listdir('.')))\"")]),
        reply(calls=[call("shell", cmd=f"{py} -c \"import sys; print('boom'); sys.exit(3)\"")]),
        reply("FINAL: done"),
    ]
    _, events, _ = run(monkeypatch, ctx, script)
    results = kinds(events, "tool_result")
    assert "marker.txt" in results[0]["output"] and not results[0]["is_error"]
    assert "boom" in results[1]["output"] and "[exit code 3]" in results[1]["output"] and results[1]["is_error"]


def test_a_shell_command_that_runs_too_long_is_killed(monkeypatch, tmp_path):
    monkeypatch.setattr(mod, "SHELL_TIMEOUT_SECONDS", 1)
    ctx = make_ctx(tmp_path)
    cmd = f'"{sys.executable}" -c "import time; time.sleep(30)"'
    _, events, _ = run(monkeypatch, ctx, [reply(calls=[call("shell", cmd=cmd)]), reply("done")])
    out = kinds(events, "tool_result")[0]
    assert out["is_error"] and "timed out after 1 seconds" in out["output"]
    assert out["duration_ms"] < 20000


def test_a_long_tool_output_is_cut_for_the_model(monkeypatch, tmp_path):
    ctx = make_ctx(tmp_path)
    (Path(ctx.workspace_dir) / "big.txt").write_text("z" * 50_000, encoding="utf-8")
    _, events, client = run(monkeypatch, ctx, [reply(calls=[call("read_file", path="big.txt")]), reply("done")])
    out = kinds(events, "tool_result")[0]["output"]
    assert out.startswith("z" * 100) and len(out) < 10_100 and "output cut" in out
    assert len([m for m in client.kwargs[1]["messages"] if m["role"] == "tool"][0]["content"]) == len(out)


def test_only_the_configured_tools_are_offered(monkeypatch, tmp_path):
    for tools, expected in ((("shell",), {"shell"}), (("files",), {"read_file", "write_file", "list_dir"}), (("shell", "files"), {"shell", "read_file", "write_file", "list_dir"})):
        _, _, client = run(monkeypatch, make_ctx(tmp_path / "-".join(tools), tools=tools), [reply("FINAL: x")])
        assert {t["function"]["name"] for t in client.kwargs[0]["tools"]} == expected


# ------------------------------------------------------------------ steps


def test_the_step_cap_ends_the_trial_as_max_steps_and_runs_the_last_calls(monkeypatch, tmp_path):
    ctx = make_ctx(tmp_path, max_steps=3)
    script = [reply(calls=[call("write_file", path=f"f{i}.txt", content=str(i))]) for i in range(5)]
    result, events, client = run(monkeypatch, ctx, script)
    assert result.exit_reason == "max_steps" and result.steps == 3 and len(client.kwargs) == 3
    assert (Path(ctx.workspace_dir) / "f2.txt").exists()
    assert len([e for e in kinds(events, "api_call") if e["status"] == "ok"]) == 3  # H-9


def test_seed_temperature_and_max_tokens_go_on_every_call(monkeypatch, tmp_path):
    ctx = make_ctx(tmp_path, seed=424242, temperature=0.3)
    _, _, client = run(monkeypatch, ctx, [reply(calls=[call("shell", cmd="echo a")]), reply("FINAL: x")])
    assert len(client.kwargs) == 2
    for kw in client.kwargs:
        assert kw["seed"] == 424242 and kw["temperature"] == 0.3 and kw["max_tokens"] == 256 and kw["model"] == "vendor/model"


def test_the_final_response_is_kept_verbatim_and_usage_is_summed(monkeypatch, tmp_path):
    ctx = make_ctx(tmp_path)
    result, events, _ = run(monkeypatch, ctx, [reply(calls=[call("shell", cmd="echo a")], usage=(100, 7)), reply("  Done.\nFINAL: 1  \n\n", usage=(150, 9))])
    assert result.final_response == "  Done.\nFINAL: 1  \n\n"
    assert (result.usage.input_tokens, result.usage.output_tokens, result.usage.api_calls) == (250, 16, 2)
    assert [e["input_tokens"] for e in kinds(events, "api_call")] == [100, 150]


def test_an_empty_reply_without_tool_calls_is_a_completed_empty_answer(monkeypatch, tmp_path):
    result, _, _ = run(monkeypatch, make_ctx(tmp_path), [reply(None)])
    assert result.exit_reason == "completed" and result.final_response == ""


# ------------------------------------------------------------------ memory


def test_seeded_memory_is_appended_to_the_system_prompt_and_traced(monkeypatch, tmp_path):
    seed = {"MEMORY.md": "Staging DB is pg-stage-07.internal:6432", "USER.md": "Name: Dana"}
    ctx = make_ctx(tmp_path, memory_seed=seed)
    result, events, client = run(monkeypatch, ctx, [reply("FINAL: x")])
    expected = f"{SYSTEM_PROMPT}\n\n## Memory\n{seed['MEMORY.md']}\n## User\n{seed['USER.md']}"
    assert client.kwargs[0]["messages"][0] == {"role": "system", "content": expected}
    assert result.system_prompt == expected
    reads = kinds(events, "memory_read")
    assert {(e["file"], e["loaded_by"]) for e in reads} == {("MEMORY.md", "adapter"), ("USER.md", "adapter")}
    assert ADAPTER.collect_memory(ctx).files == seed


def test_without_memory_the_prompt_is_exactly_the_fixed_string(monkeypatch, tmp_path):
    ctx = make_ctx(tmp_path)
    result, events, client = run(monkeypatch, ctx, [reply("FINAL: x")])
    assert client.kwargs[0]["messages"][0]["content"] == SYSTEM_PROMPT == result.system_prompt
    assert not kinds(events, "memory_read") and ADAPTER.collect_memory(ctx).files == {}


# ------------------------------------------------------------------ retries (M-3)


def test_429_and_5xx_are_retried_with_a_backoff_and_each_request_is_an_event(monkeypatch, tmp_path, no_wait):
    result, events, client = run(monkeypatch, make_ctx(tmp_path), [status_error(429), status_error(503), reply("FINAL: ok")])
    calls = kinds(events, "api_call")
    assert [(c["status"], c["http_status"]) for c in calls] == [("retry", 429), ("retry", 503), ("ok", 200)]
    assert len(client.kwargs) == 3 and result.steps == 1 and result.exit_reason == "completed"
    assert no_wait == [1, 2]


def test_retries_are_bounded_and_end_as_a_retryable_error_event(monkeypatch, tmp_path, no_wait):
    result, events, client = run(monkeypatch, make_ctx(tmp_path), [status_error(429)] * 6)
    calls = kinds(events, "api_call")
    assert [c["status"] for c in calls] == ["retry"] * 5 + ["error"]
    assert no_wait == [1, 2, 4, 8, 16] and len(client.kwargs) == 6
    assert result.exit_reason == "agent_error" and result.steps == 0
    error = kinds(events, "error")[-1]
    assert error["retryable"] is True and "HTTP 429" in error["message"]


def test_a_client_error_is_not_retried(monkeypatch, tmp_path, no_wait):
    result, events, client = run(monkeypatch, make_ctx(tmp_path), [status_error(400)])
    assert [(c["status"], c["http_status"]) for c in kinds(events, "api_call")] == [("error", 400)]
    assert len(client.kwargs) == 1 and no_wait == [] and result.exit_reason == "agent_error"


def test_a_dropped_connection_is_retried(monkeypatch, tmp_path, no_wait):
    drop = openai.APIConnectionError(request=httpx.Request("POST", "http://stub/v1/chat/completions"))
    _, events, _ = run(monkeypatch, make_ctx(tmp_path), [drop, reply("FINAL: ok")])
    assert [(c["status"], c["http_status"]) for c in kinds(events, "api_call")] == [("retry", None), ("ok", 200)]


def test_a_response_without_choices_is_a_provider_failure(monkeypatch, tmp_path, no_wait):
    empty = SimpleNamespace(choices=[], usage=None)
    _, events, _ = run(monkeypatch, make_ctx(tmp_path), [empty, reply("FINAL: ok")])
    assert [c["status"] for c in kinds(events, "api_call")] == ["retry", "ok"]
