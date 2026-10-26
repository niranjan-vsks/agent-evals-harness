# ADAPTERS.md: harness and model adapter contracts

Status: FROZEN before any adapter is written. The Hermes adapter is built against
this file first, then the minimal loop. If building either adapter forces a change
here, the change is recorded in DESIGN.md section 11 ("Contract findings") with the
reason. Silent edits to this file are a defect.

Numbering convention: every invariant has a stable id (`H-n` for harness, `M-n` for
model, `R-n` for runner) so cards, tests and DESIGN.md can cite it.

---

## 0. Where adapters live and who calls them

```
worker/
  adapters/
    __init__.py            REGISTRY: dict[str, HarnessAdapter]   (1 line per harness)
    base.py                the Protocol and dataclasses in this file, verbatim
    hermes/adapter.py      HarnessAdapter for Hermes Agent
    minimal_loop/adapter.py HarnessAdapter for the baseline loop
  models.py                make_client(ModelSpec) -> openai.OpenAI   (the only model code path)
  runner.py                subprocess runner: timeouts, kill, trace assembly (R-n invariants)
  graders/                 grading, called by the runner after the adapter returns
api/
  src/worker-client/       types.ts: TypeScript mirror of ModelSpec, the worker manifest, TrialSpec and
                           TrialResult; worker-client.ts: the HTTP client. The API never imports harness code.
```

*Changed in build:* the draft named this directory `api/src/adapters/`; it is `api/src/worker-client/`.
Nothing else about the split changed.

The control plane (NestJS) never calls an adapter. It sends a `TrialSpec` to the worker
over HTTP (`POST /trials/run`), the worker's `runner.py` resolves the adapter from
`REGISTRY[spec.harness]`, runs it in a child process, grades, and returns a
`TrialResult`. Adding a harness touches `worker/adapters/<name>/` and 1 line in
`REGISTRY`. Adding a model touches 1 JSON row in `api/seed/models.json`. Nothing else.

---

## 1. Shared types (Python, `worker/adapters/base.py`)

All fields are required unless marked `| None`. All dataclasses are frozen.

```python
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
```

### TraceEvent (JSON lines appended to `events_path`, 1 object per line)

Every event has `seq` (int, monotonically increasing from 0 within the trial), `t_ms`
(int, milliseconds since the adapter's `run()` started) and `kind`. The runner assigns
`seq` if the adapter omits it, by line order. Content fields larger than 20,000
characters are truncated by the runner with `"truncated": true` and the original length
in `"orig_len"`.

```
{"kind":"message",      "role":"system"|"user"|"assistant", "content":str, "step":int}
{"kind":"tool_call",    "call_id":str, "step":int, "tool":PlatformTool|str, "harness_tool":str, "args":object}
{"kind":"tool_result",  "call_id":str, "output":str, "is_error":bool, "duration_ms":int}
{"kind":"api_call",     "step":int, "model":str, "input_tokens":int, "output_tokens":int, "latency_ms":int, "status":"ok"|"retry"|"error", "http_status":int|null}
{"kind":"memory_read",  "file":"MEMORY.md"|"USER.md", "content":str, "loaded_by":"harness"|"adapter"}
{"kind":"memory_write", "file":str, "op":str, "args":object, "content_after":str|null}
{"kind":"skill_invoked","name":str, "via":"preload"|"tool"}
{"kind":"error",        "stage":"prepare"|"run"|"collect", "message":str, "retryable":bool}
```

`tool` is the platform name (`shell`, `files`) when the harness tool maps to 1; otherwise
the harness's own name, with `harness_tool` always carrying the harness's name. A reader
of the trace can tell what the agent did without knowing the harness.

---

## 2. HarnessAdapter protocol

```python
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
```

*Changed in build:* the worker serves validation as `POST /adapters/{id}/validate`, because the settings
travel in the request body. The draft said `GET` (DESIGN 11.1). The `validate()` docstring above and the
one in `worker/adapters/base.py` now say `POST`.

### Harness invariants

| id | Invariant | Why it exists | Enforced by |
|---|---|---|---|
| H-1 | `validate()` rejects any setting the adapter cannot honor exactly. A setting is never silently ignored or approximated. | A config that says `temperature: 0` and a harness that ignores it would compare 2 different things under 1 label. | Conformance test `test_validate_rejects_unsupported` feeds each capability gap and expects a non-empty list. The API refuses to create a config whose `validate()` is non-empty. |
| H-2 | Everything the adapter writes goes under `ctx.trial_dir`. Nothing under `$HOME`, `/tmp`, or the harness's default home. | Cross-trial state leaks through the harness's own home directory are the main contamination channel. | Conformance test runs 1 trial with `HOME` set to a read-only directory and a watch on `/tmp`; any write outside `trial_dir` fails the test. |
| H-3 | With `memory.mode == "off"`, the harness sees no memory content and has no memory tool. With `"seeded"`, the harness sees exactly `ctx.memory_seed` and nothing else. | The primary experiment's single axis is this flag. | Conformance test asserts the captured `system_prompt` (or the first `message` event with role system) contains the seed text iff mode is seeded, and that no `memory_read` event appears when off. |
| H-4 | `tools` is honored exactly: a tool outside `settings.tools` is never offered to the model. | A harness with web search enabled could answer from the internet instead of the workspace. | Conformance test with a stub model that requests every tool name it is offered; the trace must contain no `tool_call` outside the configured set. |
| H-5 | `prepare()` is deterministic and idempotent for the same `ctx`. Running it twice produces byte-identical files. | Reproduction (DESIGN.md section 6) depends on the input bundle being a pure function of the config and task. | Conformance test hashes `trial_dir` after 2 calls. |
| H-6 | `run()` never raises for model-side or tool-side failures. It returns `exit_reason: "agent_error"` with an `error` event. It raises only for programming errors. | A raised exception is treated as infra by the runner and retried; a model that produced garbage is a scored failure, not a retry. | Code review and the conformance test "stub returns malformed tool call" which must yield `invalid_tool_call` or `agent_error`, not an exception. |
| H-7 | Trace events are appended to `events_path` as they happen, flushed per line. | A trial killed by the runner at the timeout must still leave the trajectory up to the kill. | Conformance test with a stub model that stalls on call 3 under `timeout_seconds: 5`; the events file must contain calls 1 and 2. |
| H-8 | `collect_memory()` reads only from disk under `trial_dir`. | It is called after a kill in a fresh process. | Conformance test calls it in a new process after `run()`. |
| H-9 | `steps` in the result equals the count of `api_call` events with `status: "ok"`. | The UI's step count and the budget-exhaustion grader rely on 1 definition. | Conformance test. |
| H-10 | The adapter never reads `OPENROUTER_API_KEY` or any key directly. It calls `worker.models.make_client(ctx.model)` or passes `ctx.model.base_url` and `os.environ[ctx.model.api_key_env]` to the harness. | Keys resolve in exactly 1 place, so a new provider is a registry row. | grep-based test: no adapter file contains the string `API_KEY` except via `api_key_env`. |
| H-11 | `final_response` is the harness's last assistant message verbatim, untrimmed. Extraction of `FINAL:` lines is the grader's job, not the adapter's. | Graders must be harness-independent. | Code review. |

---

## 3. Hermes adapter: how it is installed and invoked

Facts verified against the clone at commit `f4ac0bea1ea50bba62886fb0b7e308e4edee8fd3`
(remote `https://github.com/NousResearch/hermes-agent.git`). Anything marked ASSUMPTION
is to be verified by the P1 builder and recorded in STATE.md.

### Install (worker Docker image)

```dockerfile
FROM python:3.14-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
ARG HERMES_COMMIT=f4ac0bea1ea50bba62886fb0b7e308e4edee8fd3
RUN git clone https://github.com/NousResearch/hermes-agent.git /opt/hermes-agent \
 && cd /opt/hermes-agent && git checkout ${HERMES_COMMIT}
RUN pip install --no-cache-dir -e /opt/hermes-agent
ENV HERMES_ADAPTER_VERSION=${HERMES_COMMIT}
```

- Python 3.14 is the only supported version (`pyproject.toml:10-15` comment and
  `.python-version`). Dependencies carry `python_version >= '3.14'` markers (`pyproject.toml:40-52`).
- `pip install -e .` is explicitly supported; wheel builds are blocked by `setup.py:36-55`.
- ASSUMPTION A-1: the editable install resolves all core dependencies on `python:3.14-slim`
  without a compiler. If a native build fails, reversible default: add `build-essential` to
  the image. If `nemo-relay` (`pyproject.toml:219`) fails to install, reversible default:
  install with `--no-deps` then install the deps listed in `pyproject.toml` minus `nemo-relay`,
  and record in STATE.md that relay tracing is unavailable.
- ASSUMPTION A-2: Hermes imports top-level modules (`run_agent`, `toolsets`, `hermes_constants`)
  by bare name. If they are not importable after the editable install, set
  `PYTHONPATH=/opt/hermes-agent` in the image.
- Hermes is not vendored. The commit is pinned by `HERMES_COMMIT`; `adapter.version` returns it.

### Per-trial preparation (`prepare()`)

1. Create `trial_dir/hermes_home/` with subdirectories `memories/`, `skills/`, `sessions/`, `logs/`.
   On Windows hosts Hermes would otherwise use `%LOCALAPPDATA%\hermes`
   (`hermes_constants.py:51-58`); inside the Linux worker container it would use `~/.hermes`.
   Both are overridden by `HERMES_HOME` (`hermes_constants.py:97`).
2. Write `trial_dir/hermes_home/config.yaml`:
   ```yaml
   model:
     default: <ctx.model.slug>
     provider: openrouter
   agent:
     max_turns: <settings.max_steps>
     coding_context: off          # disables the git/workspace snapshot in the system prompt
   memory:
     memory_enabled: <mode == "seeded">
     user_profile_enabled: <mode == "seeded">
   terminal:
     backend: local
   approvals:
     mode: off
   skills:
     auto_load: <list(settings.skills.preload)>
   ```
   Key names come from `hermes_cli/config_defaults.py` (`agent.max_turns` at :78,
   `agent.coding_context` at :205, `memory.*` at :1326-1341, `terminal.backend` at :297-298,
   `approvals.mode` read at `tools/approval.py:1169-1171`, `skills.auto_load` at :1478).
   ASSUMPTION A-3: the YAML nesting matches these dotted paths. The P1 builder confirms by
   reading `cli-config.yaml.example` and writes a test that constructs an `AIAgent` under
   this `HERMES_HOME` and asserts `agent.max_iterations == settings.max_steps`.
3. If `mode == "seeded"`: write `ctx.memory_seed["MEMORY.md"]` and `["USER.md"]` into
   `hermes_home/memories/` (`tools/memory_tool.py:38-40`). Append a `memory_read` event
   with `loaded_by: "harness"` for each file written, because Hermes loads them at init
   into the system prompt (`agent/agent_init.py:1323-1341`, `agent/system_prompt.py:522-547`).
   The seed MUST be within `memory_char_limit` 2200 and `user_char_limit` 1375 characters
   (`config_defaults.py:1334-1335`); `validate()` rejects larger fixtures (H-1).
4. If `skills.enabled`: ASSUMPTION A-4: a bare programmatic `AIAgent` does not sync bundled
   skills into a fresh `HERMES_HOME`; the survey found the sync call in `hermes_cli/main.py:1034-1046`
   only. Reversible default: the adapter calls the sync function in `tools/skills_sync.py`
   (name to be confirmed; the module exposes `_skills_dir`, `_get_bundled_dir` at :62-79)
   before constructing the agent. Skills are off in both configs of the primary experiment,
   so this assumption blocks nothing in P1 through P5.

### Invocation (`run()`)

Runs inside the runner's child process with env `HERMES_HOME=<trial_dir>/hermes_home`,
`HERMES_YOLO_MODE=1` (frozen at import, `tools/approval.py:46`; it must be set before
`import run_agent`), cwd = `ctx.workspace_dir`.

```python
from run_agent import AIAgent          # after env is set
toolsets = {"shell": "terminal", "files": "file"}      # toolsets.py:103 ("terminal"), :121 ("file")
enabled = [toolsets[t] for t in ctx.settings.tools]
if ctx.settings.memory.mode == "seeded":
    enabled.append("memory")                           # toolsets.py:129
agent = AIAgent(
    model=ctx.model.slug,
    base_url=ctx.model.base_url,
    api_key=os.environ[ctx.model.api_key_env],         # explicit pair => used directly, agent_init.py:993-996
    provider="openrouter",
    max_iterations=ctx.settings.max_steps,             # default is sys.maxsize, run_agent.py:241
    enabled_toolsets=enabled,
    disabled_toolsets=["clarify", "web", "browser", "skills" if not skills.enabled else None, ...],
    max_tokens=ctx.settings.max_output_tokens,
    request_overrides={"temperature": ctx.settings.temperature},   # only temperature path, chat_completions.py:629-670
    skip_context_files=True,                           # no SOUL.md / AGENTS.md pickup
    skip_memory=(ctx.settings.memory.mode == "off"),
    skip_background_review=True,                       # no post-turn memory/skill writes, agent_init.py:2311-2312
    save_trajectories=False,
    quiet_mode=True,
    cwd=ctx.workspace_dir,
    run_budget_seconds=ctx.settings.timeout_seconds,
    session_id=f"{ctx.trial_id}-{ctx.attempt}",
    tool_progress_callback=<appends tool_call / tool_result events>,   # tool_executor.py:1033, :1174
    step_callback=<appends api_call events>,                           # turn_iteration_prep.py:161
    clarify_callback=<returns "pick defaults">,                        # mirrors oneshot.py:661-665
)
result = agent.run_conversation(ctx.task.prompt)       # agent/turn_facade.py:22-33
agent.close()                                          # batch_runner.py:278-279 does this
```

Result mapping (`agent/turn_finalizer.py:687-721`, token keys at :33-37):

| HarnessRunResult field | Source |
|---|---|
| `final_response` | `result["final_response"]` |
| `exit_reason` | `completed` if `result["completed"]`; `invalid_tool_call` if `result["partial"]`; `max_steps` if `result["turn_exit_reason"]` names the iteration cap (ASSUMPTION A-5: exact string to be read from the code at build time and pinned in a test); else `agent_error` |
| `steps` | `result["api_calls"]` |
| `usage` | `input_tokens`, `output_tokens`, `cache_read_tokens`, `reasoning_tokens`, `api_calls` from the result dict |
| `harness_reported_cost_usd` | `result["estimated_cost_usd"]` |
| `system_prompt` | first element of `result["messages"]` with role `system` if present; ASSUMPTION A-6: Hermes includes the system message in `messages`. If not, reversible default: `None` with note `"hermes does not expose the system prompt in run_conversation output"` and `capabilities.system_prompt_capture = False`. |
| `skills_invoked` | names from `skill_view` tool calls in `result["messages"]`, plus `settings.skills.preload` |
| `message` events | every entry of `result["messages"]` in order, emitted after the run (tool call and result events were emitted live via callbacks) |
| `memory_write` events | every `memory` tool call in `result["messages"]`, with `content_after` read from disk by `collect_memory()` (changed in build: read in the `post_tool_call` hook when the write happens, DESIGN 11.19) |

`Capabilities` for Hermes: `tools={shell, files}`, `memory_modes={off, seeded}`,
`memory_writes=True`, `skills=True`, `temperature=True` (via `request_overrides`),
`seed=False` (Hermes has no seed parameter; `validate()` does not reject a seed, it is
simply unused; this is documented, not hidden), `system_prompt_capture` per A-6.

Known Hermes behaviours the adapter cannot change (recorded in DESIGN.md Known limits):
the system prompt embeds the current date (`agent/system_prompt.py:495-519`); auxiliary
LLM calls for titles and compression may run (ASSUMPTION A-7: whether their tokens are
included in `result` session totals; `--usage-file` separates them for the CLI path,
`hermes_cli/oneshot.py:31-86`); Hermes performs its own API retries (`api_max_retries` 3,
`config_defaults.py:133-139`) before the adapter sees an error.

---

## 4. Minimal loop adapter (baseline)

Written AFTER the Hermes adapter, against this frozen file. About 150 lines.

- Model client: `worker.models.make_client(ctx.model)`, chat completions with `tools`.
- Tools offered (only those in `settings.tools`): `shell` → `{"name":"shell","parameters":{"cmd":str}}`
  executed with `subprocess.run(cmd, shell=True, cwd=workspace, timeout=60)`; `files` →
  `read_file(path)`, `write_file(path, content)`, `list_dir(path)`; paths resolved under
  `workspace_dir`, escaping it returns an error result.
- System prompt: a fixed 6-line string stored in `minimal_loop/prompt.py` (hash is part of
  `adapter.version`). With `memory.mode == "seeded"` the seed is appended as
  `## Memory\n<MEMORY.md>\n## User\n<USER.md>` and a `memory_read` event with
  `loaded_by: "adapter"` is emitted.
- Loop: call model; if the assistant message has no `tool_calls` → `completed`; else execute
  each tool call, append results, repeat; stop at `max_steps` → `max_steps`. Malformed tool
  arguments (JSON parse failure) → return an error tool result, count against steps; 3
  consecutive malformed calls → `invalid_tool_call`.
- `temperature` and `seed` (ASSUMPTION A-8: OpenRouter forwards `seed` for models that
  support it; unsupported models ignore it) are passed on every call.
- `Capabilities`: `tools={shell, files}`, `memory_modes={off, seeded}`, `memory_writes=False`,
  `skills=False`, `temperature=True`, `seed=True`, `system_prompt_capture=True`.
  `validate()` returns an error for `skills.enabled == True`.

---

## 5. Model adapter: a registry row, not a code path

`api/seed/models.json` (loaded into the `model` table at API startup, upsert by `id`):

```json
[
  {
    "id": "model-a",
    "display_name": "VERIFY: Anthropic model via OpenRouter",
    "slug": "VERIFY-anthropic/<model>",
    "base_url": "https://openrouter.ai/api/v1",
    "api_key_env": "OPENROUTER_API_KEY",
    "input_price_per_mtok": 0,
    "output_price_per_mtok": 0,
    "context_window": 0,
    "roles": ["candidate", "judge"]
  },
  { "id": "model-b", "display_name": "VERIFY: OpenAI model via OpenRouter", "...": "..." }
]
```

ASSUMPTION A-9: OpenRouter exposes `GET https://openrouter.ai/api/v1/models` returning
each model's `id` and `pricing.prompt` / `pricing.completion` as USD per token. The P1
builder fetches it once, picks 1 Anthropic and 1 OpenAI slug, fills the 3 numeric fields
from the response, and records the slugs, prices and fetch date in STATE.md. Prices are
also copied into every `trial` row at run time (DATA_MODEL.md) so a later price change
never rewrites history.

`worker/models.py`:

```python
def make_client(spec: ModelSpec) -> openai.OpenAI:
    return openai.OpenAI(base_url=spec.base_url, api_key=os.environ[spec.api_key_env],
                         default_headers={"HTTP-Referer": "agent-evals-harness", "X-Title": "agent-evals-harness"},
                         max_retries=0)   # retries are the adapter's / runner's job, so they are traced
```

### Model invariants

| id | Invariant | Why | Enforced by |
|---|---|---|---|
| M-1 | A model is fully described by its registry row. No adapter branches on `model.id` or `model.slug`. | "Add a model" must be a data change. | grep test: no file under `worker/adapters/` contains `"model-a"`, `"model-b"` or a provider slug. |
| M-2 | Prices used for a trial's cost are the prices in the row at the moment the trial ran, copied into the trial. | Reproducible cost numbers. | DB column `trial.price_snapshot` NOT NULL. |
| M-3 | `max_retries=0` on the client. Every retry is an explicit `api_call` event with `status: "retry"`. | Rate-limit handling must be visible in the trace, not hidden in a library. | Conformance test with a stub returning 429 twice. |
| M-4 | The API key never appears in a `TrialSpec`, a trace, a log line or a DB row. | Keys via `.env` only. | Test: serialize a TrialSpec and a TrialResult from a run with a sentinel key; assert the sentinel is absent. |

### What a third adapter must write

Third harness: `worker/adapters/<name>/adapter.py` implementing section 2, the `REGISTRY`
line, and it must pass `worker/tests/test_adapter_conformance.py` (parametrized over
`REGISTRY`, runs against the stub model server in `worker/tests/stub_model_server.py`).
No change to `runner.py`, `graders/`, the API or the UI.

Third model: 1 object in `api/seed/models.json`. If it is not reachable through OpenRouter,
also 1 env var name in `.env.example`. No code.

---

## 6. Runner invariants (`worker/runner.py`)

| id | Invariant | Why | Enforced by |
|---|---|---|---|
| R-1 | Every trial attempt runs in a fresh child process (`python -m worker.run_one <spec.json>`), with env = minimal set + `HERMES_HOME` + the key env var named in the spec. | Import-time globals (`HERMES_YOLO_MODE`, approval caches) and module state cannot leak between trials. | Test: 2 sequential attempts, a module-level counter in a test adapter is 0 in both. |
| R-2 | The runner kills the child at `timeout_seconds + 60` (SIGKILL after SIGTERM grace of 10 s) and returns `exit_reason: "timeout"`, `status: done`, `passed: false`. The runner kill is the only hard bound: Hermes's `run_budget_seconds` is soft (a wrap-up notice at 80 percent, `agent/conversation_loop.py:124-157`) and never aborts a call. The 60 s margin only gives a harness that does stop cleanly the chance to return its own result. | A hung model call must not hang the experiment, and a budget exhaustion is a scored outcome. | Test with the stalling stub. |
| R-3 | A child that exits non-zero without writing `out/result.json` is an infra error (`error_class: worker_crash`), retryable, never a scored failure. | Distinguish "the agent failed" from "our plumbing failed". | Test: adapter that calls `os._exit(3)`. |
| R-4 | The trace returned is assembled from `out/events.jsonl` on disk, never from the child's memory. | R-2 kills leave partial events; they must still be visible. | Test with the stalling stub: trace has the pre-stall events. |
| R-5 | The fixture is copied, never symlinked, into `workspace_dir` before `prepare()`. The fixture directory is mounted read-only. | Agents write; a symlink would mutate the fixture for every later trial. | Test: run a trial whose agent writes into the workspace; fixture hash unchanged. |
| R-6 | The runner recomputes `task.version_hash` from disk and refuses to run on mismatch (`error_class: config_invalid`, not retryable). | A task edited after an experiment was created must not silently run under the old id. | Test. |
| R-7 | Grading runs after `collect_memory()` and in the same child process while `workspace_dir` still exists. Hidden test files for `unit_test` graders are copied in only after `run()` returns. | File-state and unit-test graders need the workspace; the agent must not see hidden tests. | Test: the agent's `list_dir` during the run never shows the hidden test file. |
| R-8 | `trial_dir` is deleted after the result is returned unless `KEEP_TRIAL_DIRS=1`. | Disk hygiene; also prevents a later trial from finding the old directory. | Test. |
| R-9 | Concurrency is bounded by the API (`MAX_CONCURRENT_TRIALS`, default 2). The worker rejects a request above its own `WORKER_MAX_PARALLEL` with HTTP 429, which the API treats as retryable backpressure. | Shared provider rate limits across concurrent trials are a leak channel; the bound makes it measurable. | Test. |
| R-10 | The trial's spec (it holds the task's graders) is never under `trial_dir`. The runner writes it to `<work_dir>/specs/<trial_id>-<attempt>.json`; the child reads it and deletes it before `prepare()` and fails closed (`worker_crash`) if it cannot delete it; before `prepare()` the child also refuses to run if `trial_dir` holds anything besides `workspace`, `out`, `home` and `tmp`. | Added after the secondary experiment: 7 of 66 `claude-haiku-5.5` trials opened `../spec.json`. Does not cover `/tasks` (DESIGN 13.6). | `test_spec_isolation.py`; `test_adapter_conformance.py::test_r10_an_agent_that_goes_looking_for_the_graders_finds_none` (both adapters). |

---

## 7. Conformance suite (the abstraction proof)

`worker/tests/test_adapter_conformance.py` is parametrized over every entry in `REGISTRY`
and uses `stub_model_server.py`, a tiny OpenAI-compatible HTTP server with scripted
responses (plain answer; tool call; malformed tool call; 429 twice then success; stall).
Hermes runs against the stub by setting `base_url` to it. The suite asserts H-1 through
H-11, M-3 and M-4. A third adapter is "done" when this suite is green for it; that is the
sentence the README uses.
