"""Shared types and the HarnessAdapter protocol. Verbatim from ADAPTERS.md sections 1 and 2.

ADAPTERS.md is frozen; do not edit these definitions here. A change goes in DESIGN.md
section 11 first.
"""
from dataclasses import dataclass, field
from typing import Literal, Protocol, Any

PlatformTool = Literal["shell", "files"]
MemoryMode   = Literal["off", "seeded"]

@dataclass(frozen=True)
class ModelSpec:
    id: str                 # registry id, e.g. "model-a"
    slug: str               # provider slug sent on the wire, e.g. "anthropic/claude-sonnet-4.5"
    base_url: str           # OpenAI-compatible base URL (OpenRouter for all seeded rows)
    api_key_env: str        # NAME of the env var holding the key. The key itself never crosses HTTP.
    input_price_per_mtok: float
    output_price_per_mtok: float
    context_window: int

@dataclass(frozen=True)
class MemorySettings:
    mode: MemoryMode
    fixture: str | None     # name under tasks/memory/<fixture>/ ; required when mode == "seeded"
    fixture_hash: str | None  # sha256 of the fixture directory, resolved by the API at config creation

@dataclass(frozen=True)
class SkillSettings:
    enabled: bool
    preload: tuple[str, ...]   # skill names the harness should load before the first turn

@dataclass(frozen=True)
class Settings:
    tools: tuple[PlatformTool, ...]
    memory: MemorySettings
    skills: SkillSettings
    temperature: float
    max_steps: int            # maximum model calls (tool-calling iterations) in the trial
    max_output_tokens: int    # per model call
    timeout_seconds: int      # wall clock for the whole trial, enforced by the runner (R-2)
    harness_options: dict[str, Any] = field(default_factory=dict)  # adapter-specific, opaque to core, hashed

@dataclass(frozen=True)
class TaskSpec:
    id: str
    version_hash: str         # sha256 over task JSON + fixture tree; runner re-verifies (R-6)
    prompt: str
    fixture_dir: str | None   # absolute path inside the worker container, read-only
    memory_fixture: str | None  # which fixture this task was written for (informational for the adapter)

@dataclass(frozen=True)
class TrialContext:
    trial_id: str
    attempt: int
    seed: int                 # per-trial integer; adapters pass it through where the harness accepts a seed
    model: ModelSpec
    settings: Settings
    task: TaskSpec
    trial_dir: str            # /work/trials/<trial_id>/<attempt>/ ; adapter may write anywhere under it
    workspace_dir: str        # trial_dir/workspace ; fixture already copied here by the runner before prepare()
    events_path: str          # trial_dir/out/events.jsonl ; adapter appends TraceEvents here (H-7)
    memory_seed: dict[str, str] | None  # {"MEMORY.md": "...", "USER.md": "..."} when mode == "seeded", else None

@dataclass(frozen=True)
class Usage:
    input_tokens: int
    output_tokens: int
    cache_read_tokens: int | None
    reasoning_tokens: int | None
    api_calls: int

ExitReason = Literal[
    "completed",          # harness returned a final answer on its own
    "max_steps",          # settings.max_steps reached
    "timeout",            # runner killed the process at settings.timeout_seconds (set by runner, never by adapter)
    "invalid_tool_call",  # harness stopped on malformed tool call(s)
    "agent_error",        # harness raised or reported an internal error attributable to the run, not infra
]

@dataclass(frozen=True)
class HarnessRunResult:
    final_response: str | None     # None only when exit_reason != "completed" and nothing was produced
    exit_reason: ExitReason
    steps: int                     # model calls made
    usage: Usage
    harness_reported_cost_usd: float | None
    system_prompt: str | None      # exact system prompt as sent on the first call; None with reason in notes
    skills_invoked: tuple[str, ...]
    notes: tuple[str, ...]         # free text for things the adapter could not represent; shown in the UI

@dataclass(frozen=True)
class MemorySnapshot:
    files: dict[str, str]          # {"MEMORY.md": content, ...} ; empty dict when memory mode is "off"

@dataclass(frozen=True)
class Capabilities:
    tools: frozenset[PlatformTool]
    memory_modes: frozenset[MemoryMode]
    memory_writes: bool            # True if the harness can write memory during a trial
    skills: bool
    temperature: bool
    seed: bool                     # True if the harness forwards TrialContext.seed to the model call
    system_prompt_capture: bool


class HarnessAdapter(Protocol):
    id: str                       # stable, lowercase, [a-z0-9_]; equals the REGISTRY key
    version: str                  # Hermes: git commit short hash baked into the image; minimal_loop: semver
    capabilities: Capabilities

    def validate(self, settings: Settings) -> list[str]:
        """Pure. Returns a list of human-readable reasons the adapter CANNOT honor these
        settings. Empty list means every setting will be honored exactly. Called by the
        worker's POST /adapters/{id}/validate before any trial is created (H-1)."""

    def prepare(self, ctx: TrialContext) -> None:
        """Writes harness-specific files under ctx.trial_dir (config files, memory seed,
        skills). No network. Must be idempotent for the same ctx (H-5)."""

    def run(self, ctx: TrialContext) -> HarnessRunResult:
        """Executes the task to completion or until settings.max_steps. Appends TraceEvents
        to ctx.events_path AS THEY HAPPEN (H-7). Blocking. Does not enforce the wall clock;
        the runner does (R-2)."""

    def collect_memory(self, ctx: TrialContext) -> MemorySnapshot:
        """Reads memory files from the trial dir after run(). Called even after a timeout
        kill, so it must not depend on in-process state (H-8)."""
