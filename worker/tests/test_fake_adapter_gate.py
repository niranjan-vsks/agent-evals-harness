"""The fake adapter registers only under an explicit test flag, and a worker started with the flag outside a test environment refuses to start."""
import os
import subprocess
import sys
from pathlib import Path

import pytest

from worker.registry import FAKE_ADAPTER_FLAG, assert_fake_adapter_allowed, load_registry

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
DOCKERIGNORE = REPO_ROOT / "worker" / ".dockerignore"


def _env(monkeypatch, *, flag=None, worker_env=None, node_env=None):
    for name, value in ((FAKE_ADAPTER_FLAG, flag), ("WORKER_ENV", worker_env), ("NODE_ENV", node_env)):
        monkeypatch.delenv(name, raising=False)
        if value is not None:
            monkeypatch.setenv(name, value)


def test_without_the_flag_the_registry_is_the_real_one_and_has_no_fake(monkeypatch):
    _env(monkeypatch, worker_env="test")
    assert sorted(load_registry()) == ["hermes", "minimal_loop"]


def test_the_flag_registers_the_fake_adapter_in_a_test_environment(monkeypatch):
    for kwargs in ({"worker_env": "test"}, {"node_env": "test"}):
        _env(monkeypatch, flag="1", **kwargs)
        assert sorted(load_registry()) == ["fake"]


@pytest.mark.parametrize("env", [{}, {"worker_env": "production"}, {"node_env": "production"}, {"worker_env": "prod", "node_env": "development"}])
def test_the_flag_outside_a_test_environment_is_refused(monkeypatch, env):
    _env(monkeypatch, flag="1", **env)
    with pytest.raises(RuntimeError, match="only allowed"):
        assert_fake_adapter_allowed()
    with pytest.raises(RuntimeError, match="only allowed"):
        load_registry()


def test_a_flag_that_is_not_exactly_1_does_not_register_the_fake(monkeypatch):
    _env(monkeypatch, flag="true", worker_env="test")
    assert "fake" not in load_registry()


def _import_server(env: dict[str, str]) -> subprocess.CompletedProcess:
    clean = {k: v for k, v in os.environ.items() if k not in (FAKE_ADAPTER_FLAG, "WORKER_ENV", "NODE_ENV")}
    clean["PYTHONPATH"] = str(REPO_ROOT)
    return subprocess.run([sys.executable, "-c", "import worker.server"], capture_output=True, text=True, env={**clean, **env}, timeout=120)


def test_the_server_refuses_to_start_with_the_flag_outside_a_test_environment():
    refused = _import_server({FAKE_ADAPTER_FLAG: "1", "WORKER_ENV": "production"})
    assert refused.returncode != 0 and "only allowed" in refused.stderr
    assert _import_server({FAKE_ADAPTER_FLAG: "1"}).returncode != 0


def test_the_server_starts_with_the_flag_in_a_test_environment_and_without_the_flag():
    assert _import_server({FAKE_ADAPTER_FLAG: "1", "WORKER_ENV": "test"}).returncode == 0
    assert _import_server({}).returncode == 0


def test_the_dockerignore_keeps_tests_and_every_pycache_out_of_the_image():
    lines = {ln.strip() for ln in DOCKERIGNORE.read_text(encoding="utf-8").splitlines() if ln.strip() and not ln.startswith("#")}
    assert "tests/" in lines
    assert "**/__pycache__" in lines  # `__pycache__` alone matches the build context root only
    assert "**/*.pyc" in lines
