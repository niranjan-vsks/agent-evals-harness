# Agent Evals Platform

A platform that runs an agent harness under a model on a fixed task set, grades every trial, and answers one
question with an interval: does config A beat config B, or is the difference noise?

- 2 harnesses behind one adapter contract: Hermes Agent (pinned commit, not vendored) and a small tool-calling loop (`minimal_loop`).
- 2 models, reached through OpenRouter only, as rows of a registry file.
- 22 tasks with 5 grader types (`exact_match`, `file_state`, `unit_test`, `trace_check`, `llm_judge`); the judge is validated against 30 human labels (agreement 0.833, kappa 0.638, 95 percent interval 0.32 to 0.90, policy `trusted`), reported in DESIGN 10.4.
- A paired bootstrap over tasks for the headline number, an exact sign test, McNemar when N = 1, and a pilot that picks N from the observed variance without showing the delta.
- A Vue 3 UI to create configs and experiments, compare them, and open any trial down to the event.

The design is in [DESIGN.md](DESIGN.md), the frozen adapter contract in [ADAPTERS.md](ADAPTERS.md), the schema and its invariants in [DATA_MODEL.md](DATA_MODEL.md). What is built and what is not is in [STATE.md](STATE.md); when STATE.md and a design document disagree about what exists, STATE.md wins.

```
 browser :8080            NestJS API :3000                 Python worker :8000
 Vue 3 + nginx   ----->   scheduler, stats, export  -----> runner (1 child process per trial)
 (/api/ proxied)          PostgreSQL 16 (db)               adapters: hermes, minimal_loop
                                                           graders, OpenRouter client
```

## Setup

You need Docker (Compose v2) and an OpenRouter key. Nothing else is installed on the host.

```
git clone <this repository>
cd agent-evals-harness
cp .env.example .env            # then put your key in .env as OPENROUTER_API_KEY=...
docker compose up --build
```

The first build clones Hermes at the pinned commit inside the worker image and installs it, so it needs network and takes several minutes. When `docker compose ps` shows `db`, `api`, `worker` and `web` as healthy, open <http://localhost:8080>.

| service | address | what it is |
|---|---|---|
| `web` | <http://localhost:8080> | the UI; `/api/` is proxied to the API with the prefix stripped |
| `api` | <http://localhost:3000> | the REST API, for scripts and `curl` |
| `worker` | <http://127.0.0.1:8000> | runs trials; it has no authentication, so it is bound to loopback |
| `db` | internal | PostgreSQL 16 with the invariants of DATA_MODEL.md as constraints and triggers |

Settings that matter, all optional, read from `.env` or the shell: `MAX_CONCURRENT_TRIALS` (default 2, the API's bound on trials in flight), `WORKER_MAX_PARALLEL` (default 4, the worker answers HTTP 429 above it and the API re-queues), `JUDGE_MODEL_ID` (default `model-a`), `KEEP_TRIAL_DIRS=1` (keep each trial's directory for debugging).

If the build fails on Windows with the repository inside OneDrive, set `DOCKER_BUILDKIT=0` and `COMPOSE_BAKE=false` first; every image of this project was built that way.

### Run the tests

The tests run where the code runs. Each command exits 0 when everything passes.

```
docker compose exec api npm test           # NestJS: unit, e2e against the real database, scheduler scenarios
docker compose exec worker pytest -q       # runner, adapters, conformance suite, graders, task set
docker compose build web                   # the web image's build stage runs the Vitest suite and the typecheck; a red test fails the build
```

The API suite's stub walk needs Python and is skipped inside the API container; it runs on a host that has the worker's Python environment (`E2E_PYTHON`). A few live tests spend real money and run only when asked: `docker compose exec -e RUN_LIVE=1 worker pytest tests/test_judge_live.py -q`.

### A smoke test against the real model

`docker compose exec api node scripts/walk.mjs http://localhost:3000 model-b` creates a config, runs 2 trials against the real model (about 0.0003 USD) and checks 16 things about the result. `scripts/walk-p3.mjs` does the same for a 12-trial experiment with a comparison.

## Using it

1. **Configs** (UI: Configs). Pick a harness, a model and the settings: tools, memory (`off` or `seeded` with a fixture), skills, temperature, `max_steps`, `max_output_tokens`, timeout. The harness validates the settings before the row is written; a setting it cannot honor exactly is refused with the reason (for example, the minimal loop has no skills). A config is immutable: the same settings give the same row again (HTTP 200), different settings give a new row (201).
2. **Experiments** (UI: Experiments). Pick 2 or more configs, the tasks, N trials per (task, config), and write the hypothesis. The hypothesis is frozen when the experiment starts. Start runs every trial; the page follows progress.
3. **Compare** (from an experiment). Badges first (reliability, judge policy, rate-limited trials), then the aggregate delta with its interval and the verdict, the 4 category blocks, the sign test, a per-task table, and cost, latency and tokens next to quality. A verdict is `noise` exactly when the 95 percent interval contains 0.
4. **Trial inspector** (from any trial row). Why it failed, every grader result with the judge's reasoning, the event timeline with each tool call paired to its result, memory before and after, the system prompt.

## Add a task

A task is a JSON file, an optional fixture directory, and one or more graders that must all pass. The schema is DESIGN.md 7.3.

1. Create `tasks/<id>.json`. Copy a neighbour: `tasks/mem-01-staging-db.json` (an `exact_match` on a memory fact), `tasks/det-03-slugify.json` (`unit_test`), `tasks/mem-06-release.json` (`llm_judge`). The prompt of a final-answer task must tell the agent to end with a line `FINAL: <answer>`.
2. If the task needs files, put them in `tasks/fixtures/<id>/`. Files the agent must not see (hidden tests, expected output) go in `tasks/fixtures/<id>/_hidden/`; they are copied in only after the run. If the task needs memory, add or reuse `tasks/memory/<fixture>/MEMORY.md` and `USER.md` and name it in `memory_fixture`.
3. If the answer is computed, write a generator under `tasks/gen/` (see `tasks/gen/README.md`) and commit its output, so the expected value is derived and never typed by hand.
4. Validate and register:

   ```
   docker compose exec api npm run tasks:lint     # schema, fixture paths, and that prompt, graders, category and fixture agree
   docker compose exec api npm run tasks:sync     # also runs at API start
   ```

The task appears in the UI with a `version_hash` over the JSON and every fixture byte. Editing a task later makes a new version; experiments created earlier keep the version they pinned (D-6).

## Add a harness

The contract is ADAPTERS.md 2: `validate`, `prepare`, `run`, `collect_memory`, and the invariants H-1 to H-11. The steps are in ADAPTERS.md 5 ("What a third adapter must write").

1. Create `worker/adapters/<name>/adapter.py` with a class that implements the protocol. `id` equals the registry key; `capabilities` says which settings it can honor; `validate()` returns a reason for every setting it cannot honor exactly. Write everything under `ctx.trial_dir`, append trace events as they happen, and read the model through `worker.models.make_client(ctx.model)`, never from an environment variable by name. `worker/adapters/minimal_loop/adapter.py` is the smallest complete example.
2. Add 1 line to `worker/adapters/__init__.py`:

   ```python
   REGISTRY = {"hermes": HermesAdapter(), "minimal_loop": MinimalLoopAdapter(), "<name>": <Name>Adapter()}
   ```
3. Run the conformance suite, which is parametrized over `REGISTRY` and uses a scripted stub model server: `docker compose exec worker pytest -q tests/test_adapter_conformance.py`. The adapter is done when it is green for the new entry.
4. `docker compose up -d --build worker`. The harness now appears under Configs in the UI; create a config for it there.

Nothing else changes: not `runner.py`, not `graders/`, not the API, not the UI.

## Add a model

A model is 1 object in `api/seed/models.json`, loaded into the `model` table at API start (upsert by `id`):

```json
{
  "id": "model-c",
  "display_name": "Provider: name (via OpenRouter)",
  "slug": "provider/model-name",
  "base_url": "https://openrouter.ai/api/v1",
  "api_key_env": "OPENROUTER_API_KEY",
  "input_price_per_mtok": 0.10,
  "output_price_per_mtok": 0.50,
  "context_window": 131072,
  "roles": ["candidate", "judge"]
}
```

- `slug` is what is sent to the provider. `base_url` is any OpenAI-compatible endpoint.
- `input_price_per_mtok` and `output_price_per_mtok` are USD per million tokens. On OpenRouter they come from `GET https://openrouter.ai/api/v1/models` (`pricing.prompt` and `pricing.completion` are USD per token, so multiply by 1,000,000). The price at the time a trial ran is copied into the trial, so changing it later does not rewrite old cost numbers.
- `api_key_env` names an environment variable. If the model is not reached through OpenRouter, add that variable to `.env` and `.env.example`; the worker reads `.env`.
- `roles` says whether it may be a `candidate` in a config, the `judge` of `llm_judge` graders, or both. The judge is chosen with `JUDGE_MODEL_ID`.
- Restart the API (`docker compose up -d --build api`). No code changes.

## Reproduce an experiment

The model is not deterministic, so reproduction is defined on inputs (DESIGN.md 6.2). In the UI, an experiment's page has a Reproduce button; over HTTP:

```
curl -X POST http://localhost:3000/experiments/<id>/reproduce
```

It creates a new draft pinned to the same config ids, the same task versions, the same N and axis and hypothesis, and a new seed. It refuses, and lists what no longer resolves, if a task version is no longer current, a memory fixture is missing, or the worker reports a different harness version. Start the draft to run it. The new run's outputs will differ; the comparison's interval is how much they are expected to.

## Export

On an experiment's page, or over HTTP:

```
GET /experiments/<id>/export.json?traces=1    the experiment, configs, task pins, every trial with its trace and graders, and the comparison used
GET /experiments/<id>/export.csv              1 row per trial
GET /experiments/<id>/compare.csv             the per-task and aggregate comparison, 1 row per task plus __aggregate__
GET /experiments/<id>/compare?persist=1       the comparison payload itself; persist=1 also stores it as a comparison_run
```

The committed export of the primary experiment is under `experiments/results/`.

## The primary experiment

Hermes, 1 model (`openai/gpt-oss-20b`), memory `off` against memory `seeded` with `tasks/memory/team-memory-v1`, over 22 tasks. The hypothesis was written before the run and is stored on the experiment. Pilot, chosen N, intervals per category, the 3 inspected trajectories, judge agreement, actual spend and the limits are in [DESIGN.md](DESIGN.md) section 10.4; the raw export and the scripts that ran it are in `experiments/`.

Judge validation (DESIGN.md 8.2) is a 3-step protocol; `experiments/judge-validation/README.md` has the file formats:

```
docker compose exec api npm run judge:sample -- --n 30    # writes experiments/judge-validation/sample.jsonl, blind
# label every line against its rubric, write experiments/judge-validation/labels.jsonl
docker compose exec api npm run judge:kappa               # agreement, Cohen's kappa, 95 percent interval, policy
```

## Where the design lives

| question | where |
|---|---|
| what can this platform conclude, and what can it not | DESIGN.md 1 and 13 |
| how a trial runs and is isolated | DESIGN.md 2.3, 6; ADAPTERS.md 6 (R-1 to R-9) |
| what a harness must do | ADAPTERS.md 2 (H-1 to H-11) |
| the 22 tasks and why each is there | DESIGN.md 7.2 |
| judge design, validation, thresholds | DESIGN.md 8 |
| the statistics and how N was chosen | DESIGN.md 9 |
| the experiment, its hypothesis and its results | DESIGN.md 10 |
| cost model and measured spend | DESIGN.md 12 |
| every table, column and invariant | DATA_MODEL.md (D-1 to D-16) |
| what was built, what was cut, what is open | STATE.md |

## Repository layout

```
api/           NestJS + Prisma: models, harnesses, tasks, configs, experiments, scheduler, stats, compare, export, judge tooling
web/           Vue 3 + TypeScript + Vite: Configs, Experiments, Experiment detail, Compare, Trial
worker/        Python 3.14: server.py, runner.py, run_one.py, adapters/, graders/, tests/
tasks/         <id>.json, fixtures/<id>/, memory/<fixture>/, gen/ (fixture generators)
experiments/   judge-validation/, results/ (committed exports), p2/ and p5/ (run records and scripts)
cards/         the build order, P1 to P6
```
