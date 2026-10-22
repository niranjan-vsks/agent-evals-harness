"""The HTTP surface, driven through FastAPI's test client with the fake adapter."""
from functools import partial

import pytest
from fastapi.testclient import TestClient

from worker import server
from worker.runner import RunnerConfig, run_trial
from worker.tests.conftest import make_spec


@pytest.fixture
def client(runner_env: RunnerConfig, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setattr(server, "run_trial", partial(run_trial, cfg=runner_env))
    return TestClient(server.app)


def test_health(client):
    assert client.get("/health").json() == {"status": "ok"}


def test_adapters_lists_the_registry_with_capabilities(client):
    body = client.get("/adapters").json()
    assert [a["id"] for a in body["adapters"]] == ["fake"]
    caps = body["adapters"][0]["capabilities"]
    assert caps["tools"] == ["files", "shell"]
    assert caps["memory_modes"] == ["off", "seeded"]
    assert "python" in body["worker"]


def test_validate_returns_adapter_reasons(client, tasks_dir):
    settings = make_spec(tasks_dir, options={"reject": True})["settings"]
    assert client.post("/adapters/fake/validate", json=settings).json() == {"errors": ["fake adapter was told to reject"]}
    settings["harness_options"] = {}
    assert client.post("/adapters/fake/validate", json=settings).json() == {"errors": []}


def test_validate_reports_malformed_settings_and_unknown_adapters(client):
    assert client.post("/adapters/fake/validate", json={"tools": ["shell"]}).json()["errors"]
    assert client.post("/adapters/nope/validate", json={}).status_code == 404


def test_run_returns_a_trial_result(client, tasks_dir):
    res = client.post("/trials/run", json=make_spec(tasks_dir)).json()
    assert res["status"] == "done"
    assert res["passed"] is True
