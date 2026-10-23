"""TrialSpec (API -> worker) parsing into the frozen adapter dataclasses.

TrialSpec JSON:
{
  "trial_id": str, "attempt": int, "seed": int, "harness": str,
  "model": {id, slug, base_url, api_key_env, input_price_per_mtok, output_price_per_mtok, context_window},
  "settings": {tools, memory: {mode, fixture, fixture_hash}, skills: {enabled, preload},
               temperature, max_steps, max_output_tokens, timeout_seconds, harness_options},
  "task": {id, version_hash, prompt, fixture_dir (relative to tasks/, or null), memory_fixture, graders},
  "memory_seed": {"MEMORY.md": str, "USER.md": str} | null,
  "judge_model": ModelSpec JSON | null    (required when a grader is llm_judge)
}
The API key never appears here, only the name of the env var (ADAPTERS M-4).
"""
from dataclasses import dataclass
from typing import Any

from worker.adapters.base import MemorySettings, ModelSpec, Settings, SkillSettings, TaskSpec, TrialContext


class SpecError(ValueError):
    """The spec is malformed or asks for something unrunnable. Maps to error_class config_invalid."""


def _req(d: dict[str, Any], key: str, kind: type | tuple[type, ...], where: str) -> Any:
    if key not in d:
        raise SpecError(f"{where}.{key} is required")
    v = d[key]
    if isinstance(v, bool) and bool not in (kind if isinstance(kind, tuple) else (kind,)):
        raise SpecError(f"{where}.{key} must not be a boolean")
    if not isinstance(v, kind):
        raise SpecError(f"{where}.{key} has the wrong type")
    return v


def model_from_dict(d: dict[str, Any]) -> ModelSpec:
    return ModelSpec(
        id=_req(d, "id", str, "model"),
        slug=_req(d, "slug", str, "model"),
        base_url=_req(d, "base_url", str, "model"),
        api_key_env=_req(d, "api_key_env", str, "model"),
        input_price_per_mtok=float(_req(d, "input_price_per_mtok", (int, float), "model")),
        output_price_per_mtok=float(_req(d, "output_price_per_mtok", (int, float), "model")),
        context_window=_req(d, "context_window", int, "model"),
    )


def settings_from_dict(d: dict[str, Any]) -> Settings:
    mem = _req(d, "memory", dict, "settings")
    skills = _req(d, "skills", dict, "settings")
    mode = _req(mem, "mode", str, "settings.memory")
    if mode not in ("off", "seeded"):
        raise SpecError(f"settings.memory.mode must be off or seeded, got {mode!r}")
    tools = _req(d, "tools", list, "settings")
    for t in tools:
        if t not in ("shell", "files"):
            raise SpecError(f"settings.tools has unknown platform tool {t!r}")
    opts = d.get("harness_options", {})
    if not isinstance(opts, dict):
        raise SpecError("settings.harness_options must be an object")
    return Settings(
        tools=tuple(tools),
        memory=MemorySettings(mode=mode, fixture=mem.get("fixture"), fixture_hash=mem.get("fixture_hash")),
        skills=SkillSettings(
            enabled=_req(skills, "enabled", bool, "settings.skills"),
            preload=tuple(_req(skills, "preload", list, "settings.skills")),
        ),
        temperature=float(_req(d, "temperature", (int, float), "settings")),
        max_steps=_req(d, "max_steps", int, "settings"),
        max_output_tokens=_req(d, "max_output_tokens", int, "settings"),
        timeout_seconds=_req(d, "timeout_seconds", int, "settings"),
        harness_options=opts,
    )


@dataclass(frozen=True)
class ParsedSpec:
    trial_id: str
    attempt: int
    seed: int
    harness: str
    model: ModelSpec
    settings: Settings
    task: dict[str, Any]
    memory_seed: dict[str, str] | None
    judge_model: ModelSpec | None = None


def parse_trial_spec(spec: dict[str, Any]) -> ParsedSpec:
    if not isinstance(spec, dict):
        raise SpecError("spec must be an object")
    task = _req(spec, "task", dict, "spec")
    for key in ("id", "version_hash", "prompt"):
        _req(task, key, str, "spec.task")
    seed = spec.get("memory_seed")
    if seed is not None and not (isinstance(seed, dict) and all(isinstance(v, str) for v in seed.values())):
        raise SpecError("spec.memory_seed must be an object of strings or null")
    judge = spec.get("judge_model")
    if judge is not None and not isinstance(judge, dict):
        raise SpecError("spec.judge_model must be an object or null")
    graders = task.get("graders", [])
    if any(isinstance(g, dict) and g.get("type") == "llm_judge" for g in graders) and judge is None:
        raise SpecError("spec.judge_model is required: the task has an llm_judge grader")
    trial_id = _req(spec, "trial_id", str, "spec")
    if not trial_id or any(c in trial_id for c in "/\\.") or len(trial_id) > 64:
        raise SpecError("spec.trial_id must be a short id without path separators")
    return ParsedSpec(
        trial_id=trial_id,
        attempt=_req(spec, "attempt", int, "spec"),
        seed=_req(spec, "seed", int, "spec"),
        harness=_req(spec, "harness", str, "spec"),
        model=model_from_dict(_req(spec, "model", dict, "spec")),
        settings=settings_from_dict(_req(spec, "settings", dict, "spec")),
        task=task,
        memory_seed=seed,
        judge_model=model_from_dict(judge) if judge is not None else None,
    )


def build_context(parsed: ParsedSpec, *, trial_dir: str, workspace_dir: str, events_path: str, fixture_dir: str | None) -> TrialContext:
    t = parsed.task
    return TrialContext(
        trial_id=parsed.trial_id,
        attempt=parsed.attempt,
        seed=parsed.seed,
        model=parsed.model,
        settings=parsed.settings,
        task=TaskSpec(
            id=t["id"],
            version_hash=t["version_hash"],
            prompt=t["prompt"],
            fixture_dir=fixture_dir,
            memory_fixture=t.get("memory_fixture"),
        ),
        trial_dir=trial_dir,
        workspace_dir=workspace_dir,
        events_path=events_path,
        memory_seed=parsed.memory_seed,
    )
