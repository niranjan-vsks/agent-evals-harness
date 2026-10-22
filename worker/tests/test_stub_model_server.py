"""The stub itself is test infrastructure; check it speaks the protocol the harnesses expect."""
import openai
import pytest

from worker.tests.stub_model_server import StubServer

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "terminal",
            "description": "run a command",
            "parameters": {"type": "object", "properties": {"command": {"type": "string"}}, "required": ["command"]},
        },
    }
]


@pytest.fixture
def stub():
    s = StubServer().start()
    yield s
    s.stop()


def client(stub: StubServer) -> openai.OpenAI:
    return openai.OpenAI(base_url=stub.base_url, api_key="k", max_retries=0)


def test_non_streamed_answer_with_usage(stub):
    r = client(stub).chat.completions.create(model="stub/plain", messages=[{"role": "user", "content": "hi"}])
    assert r.choices[0].message.content == "FINAL: 8081"
    assert r.usage.prompt_tokens > 0 and r.usage.completion_tokens > 0


def test_streamed_answer_is_sse_with_a_usage_chunk(stub):
    chunks = list(
        client(stub).chat.completions.create(
            model="stub/plain",
            messages=[{"role": "user", "content": "hi"}],
            stream=True,
            stream_options={"include_usage": True},
        )
    )
    text = "".join(c.choices[0].delta.content or "" for c in chunks if c.choices)
    assert text == "FINAL: 8081"
    assert chunks[-1].usage is not None


def test_streamed_tool_call_then_answer_by_step(stub):
    c = client(stub)
    first = list(c.chat.completions.create(model="stub/shell_then_answer", messages=[{"role": "user", "content": "go"}], tools=TOOLS, stream=True))
    calls = [tc for ch in first if ch.choices for tc in (ch.choices[0].delta.tool_calls or [])]
    assert calls[0].function.name == "terminal"
    assert '"command"' in calls[0].function.arguments
    second = c.chat.completions.create(
        model="stub/shell_then_answer",
        messages=[{"role": "user", "content": "go"}, {"role": "assistant", "content": None, "tool_calls": [{"id": "c", "type": "function", "function": {"name": "terminal", "arguments": "{}"}}]}, {"role": "tool", "tool_call_id": "c", "content": "ok"}],
        tools=TOOLS,
    )
    assert second.choices[0].message.content == "FINAL: 8081"


def test_rate_limit_twice_then_success_and_requests_are_recorded(stub):
    c = client(stub)
    for _ in range(2):
        with pytest.raises(openai.RateLimitError):
            c.chat.completions.create(model="stub/rate_limit_twice", messages=[{"role": "user", "content": "hi"}])
    assert c.chat.completions.create(model="stub/rate_limit_twice", messages=[{"role": "user", "content": "hi"}]).choices[0].message.content
    assert len(stub.requests) == 3


def test_echo_memory_reads_the_system_prompt(stub):
    c = client(stub)
    with_mem = c.chat.completions.create(model="stub/echo_memory", messages=[{"role": "system", "content": "DB is pg-stage-07.internal:6432"}, {"role": "user", "content": "db?"}])
    without = c.chat.completions.create(model="stub/echo_memory", messages=[{"role": "system", "content": "nothing"}, {"role": "user", "content": "db?"}])
    assert with_mem.choices[0].message.content == "FINAL: pg-stage-07.internal:6432"
    assert without.choices[0].message.content == "FINAL: unknown"
