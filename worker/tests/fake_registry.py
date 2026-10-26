"""Registry worker.registry.load_registry returns when WORKER_FAKE_ADAPTER=1 and WORKER_ENV=test."""
from worker.tests.fake_adapter import FakeAdapter

REGISTRY = {"fake": FakeAdapter()}
