"""Registry the runner tests point WORKER_REGISTRY at."""
from worker.tests.fake_adapter import FakeAdapter

REGISTRY = {"fake": FakeAdapter()}
