"""REGISTRY: 1 line per harness (ADAPTERS 0). The key equals the adapter's id."""
from worker.adapters.base import HarnessAdapter
from worker.adapters.hermes.adapter import HermesAdapter

REGISTRY: dict[str, HarnessAdapter] = {"hermes": HermesAdapter()}
