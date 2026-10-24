"""DESIGN 6.3 and 11 entry 17: a trial that ends because the provider answered with an HTTP error is
an errored trial of the right class, never a scored failure; a failure with no HTTP status to go by
is a scored agent_error. The runner decides from the adapter's last `error` event (`http_status`)."""
import pytest

from worker.runner import classify_http_status, run_trial
from worker.tests.conftest import make_spec


@pytest.mark.parametrize(
    "status,klass",
    [
        (429, "rate_limited"),
        (400, "config_invalid"),
        (401, "config_invalid"),
        (402, "config_invalid"),
        (403, "config_invalid"),
        (404, "config_invalid"),
        (408, "config_invalid"),
        (413, "config_invalid"),
        (422, "config_invalid"),
        (499, "config_invalid"),
        (500, "provider_error"),
        (502, "provider_error"),
        (503, "provider_error"),
        (504, "provider_error"),
        (599, "provider_error"),
        (200, None),
        (301, None),
        (399, None),
        (600, None),
        (None, None),
        (True, None),
        ("502", None),
        (502.0, None),
    ],
)
def test_the_class_follows_from_the_status(status, klass):
    assert classify_http_status(status) == klass


@pytest.mark.parametrize(
    "status,klass",
    [(429, "rate_limited"), (400, "config_invalid"), (401, "config_invalid"), (403, "config_invalid"), (404, "config_invalid"), (422, "config_invalid"), (500, "provider_error"), (502, "provider_error"), (503, "provider_error")],
)
def test_a_provider_http_error_is_an_errored_trial_of_that_class(runner_env, tasks_dir, status, klass):
    res = run_trial(make_spec(tasks_dir, mode=f"provider_{status}"), runner_env)
    assert res["status"] == "errored" and res["error_class"] == klass
    assert res["passed"] is None and res["grader_results"] == []
    assert str(status) in res["error_message"]
    assert any(e["kind"] == "error" and e["http_status"] == status for e in res["partial_trace"])


def test_a_failure_with_no_http_status_is_a_scored_agent_error(runner_env, tasks_dir):
    res = run_trial(make_spec(tasks_dir, mode="error_without_status"), runner_env)
    assert res["status"] == "done" and res["passed"] is False
    assert res["outcome"]["exit_reason"] == "agent_error"
    assert [g["passed"] for g in res["grader_results"]] == [False]


def test_the_retryable_flag_alone_no_longer_makes_a_trial_errored(runner_env, tasks_dir):
    """An adapter that sets retryable=true and a 429 on its api_call but gives its error event no
    http_status has told the runner nothing it will act on: the trial is scored."""
    res = run_trial(make_spec(tasks_dir, mode="old_style_retryable_error"), runner_env)
    assert res["status"] == "done" and res["passed"] is False


def test_a_provider_error_does_not_apply_to_a_trial_that_completed(runner_env, tasks_dir):
    res = run_trial(make_spec(tasks_dir, mode="ok"), runner_env)
    assert res["status"] == "done" and res["error_class"] is None
