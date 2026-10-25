"""The worker's HTTP surface. The control plane never imports harness code; it calls these
endpoints and exchanges 2 JSON shapes, TrialSpec in and TrialResult out (DESIGN 2.2).

GET  /health
GET  /adapters                    the manifest: every registered adapter and its capabilities
POST /adapters/{id}/validate      body = Settings JSON; returns the reasons it cannot be honored
POST /trials/run                  body = TrialSpec JSON; blocks until the TrialResult is ready;
                                  HTTP 429 when WORKER_MAX_PARALLEL attempts already run (R-9)
DELETE /trials/{trial_id}         SIGTERM the running trial's process group (SIGKILL on a repeat or after 10 s);
                                  200 {"cancelled": true} when a signal was delivered, else 404
"""
import os
import platform
import sys
from typing import Any

from fastapi import Body, FastAPI, HTTPException

from worker import active_trials
from worker.adapters.base import Capabilities
from worker.registry import load_registry
from worker.runner import WorkerBusy, run_trial
from worker.spec import SpecError, settings_from_dict

app = FastAPI(title="agent-evals worker")


def capabilities_json(c: Capabilities) -> dict[str, Any]:
    return {
        "tools": sorted(c.tools),
        "memory_modes": sorted(c.memory_modes),
        "memory_writes": c.memory_writes,
        "skills": c.skills,
        "temperature": c.temperature,
        "seed": c.seed,
        "system_prompt_capture": c.system_prompt_capture,
    }


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/adapters")
def adapters() -> dict[str, Any]:
    registry = load_registry()
    return {
        "adapters": [
            {"id": a.id, "version": a.version, "capabilities": capabilities_json(a.capabilities)}
            for _, a in sorted(registry.items())
        ],
        "worker": {
            "python": sys.version.split()[0],
            "platform": platform.platform(),
            "image_digest": os.environ.get("IMAGE_DIGEST"),
        },
    }


@app.post("/adapters/{adapter_id}/validate")
def validate(adapter_id: str, settings: dict[str, Any] = Body(...)) -> dict[str, list[str]]:
    adapter = load_registry().get(adapter_id)
    if adapter is None:
        raise HTTPException(status_code=404, detail=f"unknown adapter {adapter_id!r}")
    try:
        parsed = settings_from_dict(settings)
    except SpecError as e:
        return {"errors": [f"settings are malformed: {e}"]}
    return {"errors": adapter.validate(parsed)}


@app.post("/trials/run")
def run(spec: dict[str, Any] = Body(...)) -> dict[str, Any]:
    # A plain `def` endpoint: FastAPI runs it in a worker thread, so a long trial does not
    # block /health. The scheduler bounds concurrency; this is the worker's own bound (R-9).
    try:
        return run_trial(spec)
    except WorkerBusy as e:
        raise HTTPException(status_code=429, detail=str(e)) from e


@app.delete("/trials/{trial_id}")
def cancel_trial(trial_id: str) -> dict[str, bool]:
    if not active_trials.cancel(trial_id):
        raise HTTPException(status_code=404, detail=f"no running trial {trial_id!r}")
    return {"cancelled": True}
