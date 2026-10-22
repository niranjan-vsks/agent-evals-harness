"""Resolves the adapter registry. WORKER_REGISTRY names a module exposing REGISTRY; tests point
it at worker.tests.fake_registry so the runner can be exercised without a real harness."""
import importlib
import os

from worker.adapters.base import HarnessAdapter


def load_registry(module_path: str | None = None) -> dict[str, HarnessAdapter]:
    name = module_path or os.environ.get("WORKER_REGISTRY") or "worker.adapters"
    return importlib.import_module(name).REGISTRY
