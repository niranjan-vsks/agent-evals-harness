"""REGISTRY: 1 line per harness (ADAPTERS 0). The key equals the adapter's id."""
from worker.adapters.base import HarnessAdapter
from worker.adapters.hermes.adapter import HermesAdapter
from worker.adapters.minimal_loop.adapter import MinimalLoopAdapter

REGISTRY: dict[str, HarnessAdapter] = {"hermes": HermesAdapter(), "minimal_loop": MinimalLoopAdapter()}
