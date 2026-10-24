"""Where each adapter gets the HTTP status of the failure that ended a run (DESIGN 11 entry 17), and the
OpenRouter provider-routing option both accept."""
import httpx
import openai
import pytest

from worker.adapters import REGISTRY
from worker.adapters.hermes.adapter import _Recorder
from worker.tests.test_adapter_conformance import settings
from worker.tests.test_minimal_loop import ADAPTER as MINIMAL, call, kinds, make_ctx, reply, run, status_error
from worker.trace import TraceWriter


@pytest.fixture
def recorder(tmp_path):
    ctx = make_ctx(tmp_path)
    return _Recorder(TraceWriter(ctx.events_path), ctx)


def fail(rec, **kw):
    rec.api_request_error(api_call_count=1, api_duration=1.0, **kw)


class TestHermesStatusSources:
    def test_the_hook_status_wins(self, recorder):
        fail(recorder, status_code=429, reason="server_error")
        assert recorder.last_error_status("anything") == (429, "http")

    @pytest.mark.parametrize(
        "reason,status",
        [("server_error", 502), ("overloaded", 503), ("rate_limit", 429), ("upstream_rate_limit", 429), ("auth", 401), ("auth_permanent", 401), ("billing", 402), ("model_not_found", 404), ("format_error", 400)],
    )
    def test_hermes_own_classification_names_the_class_when_there_is_no_status(self, recorder, reason, status):
        fail(recorder, status_code=None, reason=reason)
        assert recorder.last_error_status("Upstream error from Darkbloom: inference generation failed") == (status, f"hermes_reason:{reason}")

    @pytest.mark.parametrize(
        "message,status",
        [
            ("Invalid API response after 1 retries: upstream server error (502, 2s)", 502),
            ("Invalid API response after 3 retries: upstream gateway timeout (504, 61s)", 504),
            ("Invalid API response after 1 retries: upstream provider overloaded (503)", 503),
            ("Invalid API response after 1 retries: upstream provider timed out (Cloudflare 524, 100s)", 524),
            ("Invalid API response after 1 retries: rate limited by upstream provider (429)", 429),
            ("Invalid API response after 1 retries: upstream error (code 418, 3s)", 418),
        ],
    )
    def test_an_invalid_response_is_read_from_hermes_own_hint(self, recorder, message, status):
        fail(recorder, status_code=None, reason="invalid_response")
        assert recorder.last_error_status(message) == (status, "hermes_hint")

    @pytest.mark.parametrize(
        "reason,message",
        [
            ("timeout", "Request timed out."),
            ("ssl_cert_verification", "certificate verify failed"),
            ("unknown", "something odd happened after 500 tokens and 404 lines"),
            ("invalid_response", "fast response (3.0s) — likely rate limited"),
            ("invalid_response", "response time 12.0s"),
        ],
    )
    def test_nothing_to_go_on_means_no_status(self, recorder, reason, message):
        fail(recorder, status_code=None, reason=reason)
        assert recorder.last_error_status(message) == (None, None)

    def test_no_failure_means_no_status(self, recorder):
        assert recorder.last_error_status("upstream server error (502, 2s)") == (None, None)

    def test_a_failure_that_was_recovered_from_does_not_count(self, recorder):
        fail(recorder, status_code=429, reason="rate_limit")
        recorder.pre_api_request(system_prompt="s", api_call_count=2)
        recorder.post_api_request(api_call_count=2, api_duration=0.1, usage={"prompt_tokens": 1, "output_tokens": 1}, assistant_message=None)
        assert recorder.last_error_status("") == (None, None)


class TestProvidersIgnored:
    @pytest.mark.parametrize("adapter_id", sorted(REGISTRY))
    def test_validate_accepts_a_list_of_provider_names_and_nothing_else(self, adapter_id):
        a = REGISTRY[adapter_id]
        assert a.validate(settings(harness_options={"providers_ignored": ["Darkbloom"]})) == []
        for bad in ([], "Darkbloom", [""], [1], None, ["ok", " "]):
            assert any("providers_ignored" in p for p in a.validate(settings(harness_options={"providers_ignored": bad}))), bad
        assert a.validate(settings(harness_options={"providers_ignored": ["Darkbloom"], "turbo": True}))  # still no unknown keys

    def test_the_minimal_loop_sends_it_as_openrouter_routing_on_every_call(self, monkeypatch, tmp_path):
        ctx = make_ctx(tmp_path)
        object.__setattr__(ctx.settings, "harness_options", {"providers_ignored": ["Darkbloom", "Groq"]})
        _, _, client = run(monkeypatch, ctx, [reply(calls=[call("shell", cmd="echo a")]), reply("FINAL: x")])
        assert len(client.kwargs) == 2
        for kw in client.kwargs:
            assert kw["extra_body"] == {"provider": {"ignore": ["Darkbloom", "Groq"]}}

    def test_the_minimal_loop_sends_nothing_extra_by_default(self, monkeypatch, tmp_path):
        _, _, client = run(monkeypatch, make_ctx(tmp_path), [reply("FINAL: x")])
        assert "extra_body" not in client.kwargs[0]


class TestMinimalLoopErrorEvent:
    def test_a_4xx_ends_with_its_status_and_is_not_marked_retryable(self, monkeypatch, tmp_path):
        result, events, _ = run(monkeypatch, make_ctx(tmp_path), [status_error(401)])
        error = kinds(events, "error")[-1]
        assert result.exit_reason == "agent_error" and error["http_status"] == 401 and error["retryable"] is False

    def test_a_5xx_after_the_retries_carries_its_status(self, monkeypatch, tmp_path):
        monkeypatch.setattr("worker.adapters.minimal_loop.adapter.time.sleep", lambda s: None)
        _, events, client = run(monkeypatch, make_ctx(tmp_path), [status_error(503)] * 6)
        error = kinds(events, "error")[-1]
        assert error["http_status"] == 503 and error["retryable"] is True and len(client.kwargs) == 6

    def test_a_dropped_connection_has_no_status(self, monkeypatch, tmp_path):
        monkeypatch.setattr("worker.adapters.minimal_loop.adapter.time.sleep", lambda s: None)
        drop = openai.APIConnectionError(request=httpx.Request("POST", "http://stub/v1/chat/completions"))
        _, events, _ = run(monkeypatch, make_ctx(tmp_path), [drop] * 6)
        assert kinds(events, "error")[-1]["http_status"] is None

    def test_an_error_object_behind_an_http_200_gives_its_code(self, monkeypatch, tmp_path):
        from types import SimpleNamespace

        body = {"code": 502, "message": "Upstream error from Darkbloom: inference generation failed"}
        broken = SimpleNamespace(choices=[], usage=None, error=body)
        monkeypatch.setattr("worker.adapters.minimal_loop.adapter.time.sleep", lambda s: None)
        _, events, client = run(monkeypatch, make_ctx(tmp_path), [broken] * 6)
        error = kinds(events, "error")[-1]
        assert error["http_status"] == 502 and "Darkbloom" in error["message"] and len(client.kwargs) == 6
        assert [c["http_status"] for c in kinds(events, "api_call")][-1] == 502
