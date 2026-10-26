"""Resolves the adapter registry.

The production registry is worker.adapters.REGISTRY. The runner tests swap it for the fake adapter (worker.tests.fake_registry)
by setting WORKER_FAKE_ADAPTER=1, and only when WORKER_ENV or NODE_ENV is "test": a worker started with the flag in any other
environment refuses to start (server.py calls assert_fake_adapter_allowed at import) and every load_registry call raises. The
fake adapter answers `FINAL: 8081` with canned tokens, so it must never be selectable through a stray `.env` line. The tests/
directory is also kept out of the image (worker/.dockerignore).
"""
import importlib
import os

from worker.adapters.base import HarnessAdapter

FAKE_ADAPTER_FLAG = "WORKER_FAKE_ADAPTER"


def fake_adapter_enabled() -> bool:
    return os.environ.get(FAKE_ADAPTER_FLAG, "") == "1"


def assert_fake_adapter_allowed() -> None:
    """Raises when the test flag is set outside a test environment."""
    if fake_adapter_enabled() and "test" not in (os.environ.get("WORKER_ENV"), os.environ.get("NODE_ENV")):
        raise RuntimeError(f"{FAKE_ADAPTER_FLAG}=1 is only allowed when WORKER_ENV or NODE_ENV is \"test\"; refusing to register the fake adapter")


def load_registry() -> dict[str, HarnessAdapter]:
    assert_fake_adapter_allowed()
    if fake_adapter_enabled():
        return importlib.import_module("worker.tests.fake_registry").REGISTRY
    return importlib.import_module("worker.adapters").REGISTRY
