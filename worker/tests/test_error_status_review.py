"""Cases the review of the error classification (DESIGN 11 entry 17) found: what must NOT become an HTTP status,
what a partial answer must not hide, and the wiring of providers_ignored through to the request."""
from types import SimpleNamespace

import httpx
import openai
import pytest

from worker.adapters import REGISTRY
from worker.adapters.hermes.adapter import HermesAdapter, _Recorder
from worker.tests.test_adapter_conformance import settings
from worker.tests.test_minimal_loop import kinds, make_ctx, run
from worker.trace import TraceWriter


@pytest.fixture
def recorder(tmp_path):
    ctx = make_ctx(tmp_path)
    return _Recorder(TraceWriter(ctx.events_path), ctx)


def fail(rec, **kw):
    rec.api_request_error(api_call_count=1, api_duration=1.0, **kw)


class TestHermesStatusIsOnlyWhatWasAnHttpError:
    def test_a_refusal_delivered_with_http_200_has_no_status(self, recorder):
        """finish_reason content_filter: Hermes fires the hook with status_code None and this reason. It is a
        refusal, a scored outcome, not an HTTP 400."""
        fail(recorder, status_code=None, reason="content_policy_blocked")
        assert recorder.last_error_status("content_policy_blocked: the model declined") == (None, None)

    def test_a_real_http_400_with_that_reason_keeps_its_status(self, recorder):
        fail(recorder, status_code=400, reason="content_policy_blocked")
        assert recorder.last_error_status("") == (400, "http")

    @pytest.mark.parametrize(
        "reason,message",
        [
            ("timeout", "Request timed out. upstream server error (502, 2s)"),
            ("unknown", "Invalid API response after 1 retries: upstream server error (502, 2s)"),
            ("invalid_response", "the model wrote: upstream server error (502, 2s)"),
            ("invalid_response", "Invalid API response after x retries: upstream server error (502, 2s)"),
        ],
    )
    def test_the_hint_is_read_only_from_hermes_own_text_for_an_invalid_response(self, recorder, reason, message):
        fail(recorder, status_code=None, reason=reason)
        assert recorder.last_error_status(message) == (None, None)

    def test_the_hint_is_read_when_it_is_hermes_own(self, recorder):
        fail(recorder, status_code=None, reason="invalid_response")
        assert recorder.last_error_status("Invalid API response after 3 retries: upstream gateway timeout (504, 61s)") == (504, "hermes_hint")


class TestAPartialAnswerDoesNotHideAnHttpFailure:
    def _map(self, recorder, result):
        class Writer:
            def __init__(self):
                self.events = []

            def emit(self, kind, **kw):
                self.events.append({"kind": kind, **kw})

        w = Writer()
        out = HermesAdapter()._map_result(result, recorder, [], w, make_ctx(__import__("pathlib").Path(recorder._ctx.trial_dir).parent))
        return out, w.events

    def test_failed_and_partial_with_a_502_is_an_agent_error_carrying_its_status(self, recorder):
        fail(recorder, status_code=502, reason="server_error")
        out, events = self._map(recorder, {"failed": True, "partial": True, "completed": False, "error": "502 bad gateway", "final_response": "half an answer"})
        assert out.exit_reason == "agent_error"
        assert events[-1]["kind"] == "error" and events[-1]["http_status"] == 502

    def test_partial_without_a_failure_is_still_an_invalid_tool_call(self, recorder):
        out, events = self._map(recorder, {"partial": True, "completed": False, "final_response": "x"})
        assert out.exit_reason == "invalid_tool_call" and not events

    def test_exhausted_context_compression_keeps_its_old_reading(self, recorder):
        fail(recorder, status_code=413, reason="payload_too_large")
        out, _ = self._map(recorder, {"failed": True, "partial": True, "failure_reason": "context_overflow", "error": "too long", "final_response": "x"})
        assert out.exit_reason == "invalid_tool_call"


class TestMinimalLoopUnusableAnswers:
    def _fast(self, monkeypatch):
        monkeypatch.setattr("worker.adapters.minimal_loop.adapter.time.sleep", lambda s: None)

    def test_a_reply_that_is_not_a_chat_completion_is_a_provider_failure_without_a_status_not_a_crash(self, monkeypatch, tmp_path):
        self._fast(monkeypatch)
        for junk in ("<html>bad gateway</html>", ["x"], None):
            result, events, client = run(monkeypatch, make_ctx(tmp_path / str(type(junk).__name__)), [junk] * 6)
            assert result.exit_reason == "agent_error" and len(client.kwargs) == 6
            assert kinds(events, "error")[-1]["http_status"] is None

    def test_a_body_that_is_not_json_is_not_a_crash(self, monkeypatch, tmp_path):
        self._fast(monkeypatch)
        bad = openai.APIResponseValidationError(response=httpx.Response(200, request=httpx.Request("POST", "http://x")), body="nope")
        result, events, _ = run(monkeypatch, make_ctx(tmp_path), [bad] * 6)
        assert result.exit_reason == "agent_error" and kinds(events, "error")[-1]["http_status"] is None
        value_error = ValueError("Expecting value: line 1 column 1 (char 0)")
        result, _, _ = run(monkeypatch, make_ctx(tmp_path / "v"), [value_error] * 6)
        assert result.exit_reason == "agent_error"

    def test_an_error_object_next_to_a_choice_and_a_string_code_still_give_the_status(self, monkeypatch, tmp_path):
        self._fast(monkeypatch)
        choice = SimpleNamespace(finish_reason="error", message=SimpleNamespace(content="", tool_calls=None))
        broken = SimpleNamespace(choices=[choice], usage=None, error={"code": "502", "message": "Upstream error from Stub: boom"})
        _, events, client = run(monkeypatch, make_ctx(tmp_path), [broken] * 6)
        assert kinds(events, "error")[-1]["http_status"] == 502 and len(client.kwargs) == 6

    def test_finish_reason_error_without_a_code_is_a_5xx(self, monkeypatch, tmp_path):
        """OpenRouter's own marker for a failure upstream of it. It came with no code, so 502 stands for the class."""
        self._fast(monkeypatch)
        choice = SimpleNamespace(finish_reason="error", message=SimpleNamespace(content="", tool_calls=None))
        _, events, _ = run(monkeypatch, make_ctx(tmp_path), [SimpleNamespace(choices=[choice], usage=None)] * 6)
        error = kinds(events, "error")[-1]
        assert error["http_status"] == 502 and "finish_reason: error" in error["message"]

    def test_an_empty_choices_list_with_no_error_object_has_no_status(self, monkeypatch, tmp_path):
        self._fast(monkeypatch)
        _, events, _ = run(monkeypatch, make_ctx(tmp_path), [SimpleNamespace(choices=[], usage=None)] * 6)
        error = kinds(events, "error")[-1]
        assert error["http_status"] is None and "choices: 0" in error["message"]


class TestProvidersIgnoredReachesTheRequest:
    @pytest.mark.parametrize("adapter_id", sorted(REGISTRY))
    def test_the_provider_ignore_list_is_in_the_body_the_provider_receives(self, adapter_id, world):
        run_ = world.run(adapter_id, "plain", timeout=120, options={"providers_ignored": ["Darkbloom"]})
        assert run_.result["status"] == "done"
        assert run_.chat_requests[0]["body"]["provider"]["ignore"] == ["Darkbloom"]

    @pytest.mark.parametrize("adapter_id", sorted(REGISTRY))
    def test_without_the_option_the_body_has_no_provider_routing(self, adapter_id, world):
        run_ = world.run(adapter_id, "plain", timeout=120)
        assert "ignore" not in (run_.chat_requests[0]["body"].get("provider") or {})

    @pytest.mark.parametrize("adapter_id", sorted(REGISTRY))
    def test_a_name_with_stray_whitespace_is_refused_because_openrouter_compares_exactly(self, adapter_id):
        a = REGISTRY[adapter_id]
        assert a.validate(settings(harness_options={"providers_ignored": ["Darkbloom "]}))
        assert a.validate(settings(harness_options={"providers_ignored": [" Darkbloom"]}))
        assert a.validate(settings(harness_options={"providers_ignored": ["Darkbloom"]})) == []
