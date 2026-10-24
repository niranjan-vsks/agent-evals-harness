"""The only model code path (ADAPTERS 5): a registry row in, an OpenAI-compatible client out."""
import os
from typing import TYPE_CHECKING

from worker.adapters.base import ModelSpec

if TYPE_CHECKING:
    import openai


def make_client(spec: ModelSpec) -> "openai.OpenAI":
    import openai  # noqa: PLC0415 - imported when a model is called, not when the worker starts (about 5 s on a slow host)

    return openai.OpenAI(
        base_url=spec.base_url,
        api_key=os.environ[spec.api_key_env],
        default_headers={"HTTP-Referer": "agent-evals-harness", "X-Title": "agent-evals-harness"},
        max_retries=0,  # retries are the adapter's / runner's job, so they are traced
    )
