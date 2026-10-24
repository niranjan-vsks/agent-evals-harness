"""Behaviour of the minimal loop that the independent review of P2 asked to be pinned: what the shell
can see, what survives the trial, and inputs that must be results and not crashes (H-6)."""
import json
import os
import sys
import time
from pathlib import Path

import pytest

from worker.tests.test_minimal_loop import ADAPTER, call, kinds, make_ctx, reply, run


def py(code: str) -> str:
    return f'"{sys.executable}" -c "{code}"'


def test_a_long_shell_output_keeps_its_tail_and_the_exit_code(monkeypatch, tmp_path):
    ctx = make_ctx(tmp_path)
    cmd = py("import sys; print('a' * 30000); print('THE-TRACEBACK-TAIL'); sys.exit(2)")
    _, events, _ = run(monkeypatch, ctx, [reply(calls=[call("shell", cmd=cmd)]), reply("done")])
    out = kinds(events, "tool_result")[0]["output"]
    assert "THE-TRACEBACK-TAIL" in out and "characters omitted" in out and out.rstrip().endswith("[exit code 2]")


def test_the_shell_does_not_see_provider_keys(monkeypatch, tmp_path):
    monkeypatch.setenv("SOME_PROVIDER_API_KEY", "sk-secret-123")
    monkeypatch.setenv("HARMLESS_SETTING", "visible")
    cmd = py("import os; print(os.environ.get('SOME_PROVIDER_API_KEY'), os.environ.get('HARMLESS_SETTING'))")
    _, events, _ = run(monkeypatch, make_ctx(tmp_path), [reply(calls=[call("shell", cmd=cmd)]), reply("done")])
    assert kinds(events, "tool_result")[0]["output"].strip() == "None visible"


def test_a_command_that_reads_stdin_gets_end_of_file_instead_of_hanging(monkeypatch, tmp_path):
    cmd = py("import sys; print(repr(sys.stdin.read()))")
    _, events, _ = run(monkeypatch, make_ctx(tmp_path), [reply(calls=[call("shell", cmd=cmd)]), reply("done")])
    out = kinds(events, "tool_result")[0]
    assert out["output"].strip() == "''" and out["duration_ms"] < 20000


@pytest.mark.skipif(sys.platform == "win32", reason="process groups")
def test_a_background_process_does_not_outlive_the_trial(monkeypatch, tmp_path):
    marker = tmp_path / "bg.pid"
    # Output redirected, as an agent does for a server: otherwise the command would hold the pipe open and run into its own timeout.
    cmd = f"sleep 300 > /dev/null 2>&1 & echo $! > {marker}"
    run(monkeypatch, make_ctx(tmp_path), [reply(calls=[call("shell", cmd=cmd)]), reply("done")])
    pid = int(marker.read_text().strip())

    def dead() -> bool:
        try:
            state = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[0]
        except (FileNotFoundError, ProcessLookupError):
            return True
        return state == "Z"  # killed but not yet reaped: a container's pid 1 may not reap orphans

    for _ in range(30):
        if dead():
            return
        time.sleep(0.1)
    os.kill(pid, 9)
    pytest.fail("the backgrounded process survived the trial")


def test_a_nul_in_a_command_or_path_is_an_error_result_not_a_crash(monkeypatch, tmp_path):
    script = [
        reply(calls=[("shell", json.dumps({"cmd": "echo a\u0000b"}))]),
        reply(calls=[("read_file", json.dumps({"path": "a\u0000b"}))]),
        reply("done"),
    ]
    result, events, _ = run(monkeypatch, make_ctx(tmp_path), script)
    assert result.exit_reason == "completed"
    assert all(r["is_error"] for r in kinds(events, "tool_result"))


def test_a_lone_surrogate_in_model_text_does_not_kill_the_trial(monkeypatch, tmp_path):
    result, events, _ = run(monkeypatch, make_ctx(tmp_path), [reply("answer \ud800 end FINAL: 1")])
    assert result.exit_reason == "completed"
    assert "\ud800" not in result.final_response and result.final_response.endswith("FINAL: 1")
    assert kinds(events, "message")[-1]["content"] == result.final_response


def test_a_reply_cut_off_by_the_token_limit_is_noted(monkeypatch, tmp_path):
    cut = reply("partial answer")
    cut.choices[0].finish_reason = "length"
    result, _, _ = run(monkeypatch, make_ctx(tmp_path), [cut])
    assert result.exit_reason == "completed"
    assert any("cut off at max_output_tokens" in n for n in result.notes)


def test_tool_results_return_with_their_call_ids_and_the_assistant_turn_keeps_its_text(monkeypatch, tmp_path):
    first = reply("let me look", calls=[call("shell", cmd="echo one"), call("shell", cmd="echo two")])
    first.choices[0].message.tool_calls[1].id = ""
    _, _, client = run(monkeypatch, make_ctx(tmp_path), [first, reply("FINAL: x")])
    history = client.kwargs[1]["messages"]
    assistant = [m for m in history if m["role"] == "assistant"][0]
    tools = [m for m in history if m["role"] == "tool"]
    assert assistant["content"] == "let me look"
    assert [c["id"] for c in assistant["tool_calls"]] == ["call_0", "call_1_1"]
    assert [t["tool_call_id"] for t in tools] == ["call_0", "call_1_1"]
    assert [t["content"].strip() for t in tools] == ["one", "two"]


def test_validate_rejects_a_temperature_providers_cannot_honor():
    from worker.tests.test_adapter_conformance import settings

    assert ADAPTER.validate(settings(temperature=0.7)) == []
    for bad in (-0.1, 2.5):
        assert any("temperature" in p for p in ADAPTER.validate(settings(temperature=bad)))
