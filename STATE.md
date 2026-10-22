# STATE.md

What is built, verified, cut and left open. 1 section per phase, newest first. Written
after the fact by the session that built the phase. When this file and a card disagree
about what exists, this file wins (the card is authoritative only for what is not yet
built). `FORGE_RESUME.md` is the per-session resume scratch written at pre-compact; it is
gitignored and never the record. This file is.

Each phase section has exactly these headings: Shipped, Verified (with the N of N
numbers and the mutation test), Cut on purpose, Found but not fixed, Assumptions
resolved (A-ids with outcome), Next action.

---

## 0. Orientation (read in 30 seconds)

**What this is.** A take-home: a platform that evaluates any agent harness running with
any model and says whether config A beats config B with confidence intervals. The
assignment PDF is the authority; DESIGN.md is the design; ADAPTERS.md is the frozen
adapter contract; DATA_MODEL.md is the schema with named invariants; `cards/P1..P6.md`
are the build order, 1 phase each, P6 is cuttable stretch.

**Stack (fixed by the assignment).** NestJS + Prisma + PostgreSQL 16 (`api/`), Vue 3 +
TypeScript + Vite (`web/`), Python 3.14 worker with FastAPI (`worker/`) that runs the
harnesses and graders. `docker compose up` brings up `db`, `api`, `worker`, `web`. Keys in
`.env` (`OPENROUTER_API_KEY`). Models are reached through OpenRouter only.

**Harnesses.** Hermes Agent (required), not vendored: cloned at
`https://github.com/NousResearch/hermes-agent.git` commit
`f4ac0bea1ea50bba62886fb0b7e308e4edee8fd3` inside the worker image, `pip install -e`. A
local checkout for reading is at `../hermes-agent`. Second harness: `minimal_loop`, a
~150-line tool-calling loop written after the contract was frozen.

**Primary experiment.** Hermes, 1 fixed model, memory `off` vs memory `seeded` with
`tasks/memory/team-memory-v1`. Paired bootstrap over 22 tasks, N chosen by a 3-trial
pilot (expected 5). Verdict is "noise" iff the 95 percent CI contains 0.

**Layout.** `api/ web/ worker/ tasks/ experiments/ cards/` plus the 4 documents and
this file. See DESIGN.md 2.4.

**Rules that trip cold sessions.** Configs are immutable (D-3); tasks are versioned by
hash (D-2, D-6); never set an experiment `completed` with an errored trial (D-8); the
adapter contract is frozen (ADAPTERS.md, changes go in DESIGN.md 11); no Docker-in-Docker;
no em-dashes in documents; numerals, not words; every unverified claim is an `A-n`
assumption and gets resolved here.

**Phases.** P1 foundation + Hermes + 1 trial. P2 minimal loop + graders + 22 tasks +
judge tooling. P3 experiments + scheduler + stats + exports. P4 UI. P5 the real
experiment + README + video script. P6 failure categories (stretch). After P3 the
submission is coherent without the UI.

**Status.** P1 is built and tested on the host. It is NOT done: gates 2, 4 and 5 and
`docker compose build` were NOT RUN because Docker is not installed on this machine. Next
action: see the P1 section, "Next action".

---

## P1: Foundation, worker runner, Hermes adapter, 1 trial end to end

Built on Windows 11 with Node 24.14, Python 3.14.4 (via uv), an embedded PostgreSQL 16.14 for
the API tests, and no Docker. Commits: `S1`, `S2`, `S3`, `S4`, `S5` (one per slice, slice
name in the message).

### Shipped

- **S1** `docker-compose.yml` (db, api, worker, web), `.env.example`, `api/Dockerfile`,
  `worker/Dockerfile`, `web/` placeholder. Prisma schema for all 15 tables of DATA_MODEL.md
  and `0002_invariants/migration.sql` (D-2, D-3, D-8, D-9, D-10, D-11, D-13, the trace
  write-once rule and the column CHECKs). `GET /models` with the boot-time seed.
- **S2** Worker: `server.py` (`GET /health`, `GET /adapters`, `POST /adapters/{id}/validate`,
  `POST /trials/run`), `runner.py` (R-1 to R-8; R-9 is P3), `run_one.py`, `spec.py` (TrialSpec
  parsing), `trace.py` (flushed writer, tolerant reader), `task_hash.py`, the `exact_match` and
  `file_state` graders, `tests/fake_adapter.py`, `tests/stub_model_server.py` (OpenAI-compatible,
  SSE and plain JSON, 12 scripted scenarios chosen by the model slug).
- **S3** `worker/adapters/hermes/adapter.py` and the conformance suite
  (`test_adapter_conformance.py`, parametrized over `REGISTRY`) plus
  `test_hermes_adapter.py` for the Hermes-specific assumptions.
- **S4** `api/src/common/canonical-json.ts`, `api/src/tasks/` (hash, load, schema, sync,
  `GET /tasks`, `POST /tasks/sync`, `tasks:lint`, `tasks:sync`), tasks `det-06-ini` and
  `mem-01-staging-db`, memory fixture `team-memory-v1`, `tasks/_hashvector/`.
- **S5** `api/src/worker-client/`, `harnesses/` (`GET /harnesses`), `configs/` (`POST /configs`
  201 then 200, `GET /configs[/:id]`, 405 on PUT, PATCH and DELETE), `trials/` (`POST
  /trials/adhoc`, `GET /trials/:id`, `GET /trials/:id/trace`, pure `ingest.ts`), the real model
  slugs and prices, and `api/scripts/walk.mjs` (the gate 4 walk as a script).

**Defaults used for the section 10 open questions** (none was asked):

1. SSE: the stub serves SSE `data:` chunks and plain JSON; Hermes streams, as in production.
2. `turn_exit_reason` for the cap read from the code and pinned (A-5); unknown reasons map to
   `agent_error` with the raw string in `notes`.
3. System message absent from `result["messages"]` (A-6 false): captured from the
   `pre_api_request` hook, fallback `agent._cached_system_prompt`; `system_prompt_capture` stays
   `True`.
4. Models: the cheapest non-batch, non-free OpenRouter chat model with tool calling per vendor.
   Fetched 2026-10-22T22:13:29Z from `https://openrouter.ai/api/v1/models` (HTTP 200, 468
   models). `model-a` = `anthropic/claude-haiku-5.5`, 0.10 USD in and 0.50 USD out per 1M
   tokens, context 1,000,000. `model-b` = `openai/gpt-oss-20b`, 0.018 USD in and 0.09 USD out
   per 1M tokens, context 131,072. Choice: `model-b` is the candidate of the primary experiment
   (the cheaper row, DESIGN 10.1) and `model-a` the judge (`JUDGE_MODEL_ID=model-a`); the prices
   do not argue otherwise.
5. Versions (lockfile-pinned): Node 24 image `node:24-bookworm-slim` (not the card's Node 20:
   Node 20 reached end of life on 2026-04-30), NestJS 11.2.7 and Nest CLI 11.0.24 (not 12.2.0:
   card section 1 names Jest, and the Nest 12 scaffold is ESM with Vitest), Prisma 7.10.1 (the
   `latest` dist-tag is `8.0.0-rc.26`, a release candidate), TypeScript 5.9.3, Jest 30.5.2,
   zod 4.6.7, pg 8.23.1. Python: FastAPI 0.161.0, uvicorn 0.54.0, pytest 9.1.1, openai 2.24.0
   (Hermes's pin), httpx 0.28.1. Hermes `f4ac0bea1e`.
6. No worker parallelism; `POST /trials/adhoc` is synchronous.
7. `agent.api_max_retries: 0`, plus 2 more switches; see DESIGN 11 entry 6 and the
   "Found but not fixed" list for what remains.

### Verified

Everything below ran on the host. Nothing ran inside a container.

| Gate | Result |
|---|---|
| 1 Harness, worker | `cd worker && pytest -q`: 110 passed in 506.73 s, `110 of 110 passed`, 0 failed, 1 deprecation warning (starlette TestClient) |
| 1 Harness, api | `cd api && npm test`: default `Tests: 115 passed, 3 skipped, 118 total` (the 3 skipped are the stub walk, which needs Python); with `E2E_PYTHON` set `118 passed, 118 total`, `118 of 118 passed` |
| 1 Mutation test | `worker/trace.py` `TraceWriter.emit` changed to buffer instead of flush (H-7 broken). The stall tests went red: `test_adapter_conformance.py::test_h7_events_survive_a_kill[hermes]`, `test_runner.py::test_r4_trace_is_assembled_from_disk_after_a_kill` and `test_runner.py::test_r2_killed_child_process_is_gone` (3 failed, 0 passed, trace empty after the kill). The file was restored from a copy and the suites re-run green. |
| 2 Audit in containers | NOT RUN. `docker` is not installed; `docker compose version` fails with "command not found" and WSL is not installed. |
| 3 Typecheck and build | `cd api && npm run build`: exit 0, 0 errors (Prisma client generated, `nest build`). `docker compose build`: NOT RUN. |
| 4 The walk under compose | NOT RUN. The 2 trial ids the gate needs are therefore not available. |
| 5 Live | NOT RUN (it is gate 4). |

Host equivalents of gate 4. They are not gate 4, and no row below stands in for it:

- Stub model, real worker, real Hermes (`api/src/trials/stub-walk.e2e.spec.ts`, needs
  `E2E_PYTHON`): POST /configs 201 then 200 with the same id, `det-06-ini` passes with
  `message`, `tool_call`, `tool_result` and `api_call` events; `mem-01-staging-db` under a
  seeded config has a `memory_read` event, "pg-stage-07" in the system prompt, and passes;
  under a memory-off config it fails with no memory event. Trial ids of the last run:
  `01M5JX1ASAS44DVV9G0NJKYVJ0` (det-06-ini), `01M5JX24T7716RX1SX6JVABK8R` (mem-01-staging-db).
- Real OpenRouter key from `.env`, `model-b`, bare host stack (embedded Postgres, uvicorn,
  `node dist/main`), `node api/scripts/walk.mjs`: WALK PASSED, 16 of 16 checks, twice. Last
  run: `01M5JXHQ7Y9XSS1NSPFCCCR11S` (det-06-ini; passed, 2 steps, 9,433 input and 73 output
  tokens, cost 0.000176 USD, 54.4 s) and `01M5JXKFZ9S1DKVEPVNS3FP5M3` (mem-01-staging-db;
  passed, 1 step, 5,675 and 69 tokens, 0.000108 USD, 30.8 s). The database was discarded at
  teardown, so those ids no longer resolve. Total spend for the 4 trials of the 2 walks: about 0.0006 USD.

Phase assertions: D-2, D-3, D-4, D-8, D-9, D-10, D-11, D-13, D-14 tested (`invariants.spec.ts`,
`configs.spec.ts`, `adhoc.spec.ts`, `ingest.spec.ts`); R-1 to R-8 tested (`test_runner.py`,
including the stall for R-2 and the `os._exit(3)` crash for R-3); H-1 to H-11, M-1, M-3, M-4
tested for `hermes` (`test_adapter_conformance.py`); A-9 recorded above.

How the host run was set up, so it can be repeated: `uv python install 3.14`; clone
`../hermes-agent` to a short path (`C:\hx\hermes`, with `core.longpaths`, because the clone has
paths over 260 characters) and check out `f4ac0bea1e`; `uv venv`; `uv pip install -e
C:\hx\hermes pytest`. Worker tests: `cd worker && C:\hx\venv\Scripts\python.exe -m pytest`. API
tests: `cd api && E2E_PYTHON=C:/hx/venv/Scripts/python.exe npm test` (starts an embedded
PostgreSQL 16 when `DATABASE_URL` is unset; with it set, the suite creates `<db>_test` on that
server).

### Cut on purpose

Everything in the card's out-of-scope list: the minimal loop, graders other than `exact_match`
and `file_state`, the scheduler and any retry beyond the runner's, statistics, exports, the Vue
UI, the judge, and tasks other than the 2 named in section 7. Also not built: R-9 (P3),
`WORKER_MAX_PARALLEL`, a README, `tasks/todo.md` and `tasks/lessons.md` (no correction came up,
and `tasks/` holds task definitions here).

### Found but not fixed

1. **No container has been built or run.** The Dockerfiles, `docker-compose.yml`, the health
   checks and the `api` start command (`prisma migrate deploy && node dist/main`) are written
   and unexecuted. The Linux half of R-2 (`os.killpg` with SIGTERM then SIGKILL) has never
   run; the host run used `taskkill /T /F`. A-1 is not verified on `python:3.14-slim`.
2. **Trials are slow on this host.** 13 to 25 s of Hermes import and init per trial (7.7 s
   import, 2.9 s init), 1 to 4 s per `terminal` call on Windows, 52 s end to end for
   `det-06-ini` with the real model. P5 has 2 configs x 22 tasks x N (about 5) trials.
3. **`model-a` takes no `temperature` or `seed`** on OpenRouter (its `supported_parameters`
   lacks both), so a temperature of 0 may be dropped for it. `model-b` takes both. Matters for
   the judge and for the secondary experiment.
4. **Cost is tokens x base price.** It ignores cache-read discounts and the tiered price
   `model-a` has above 100,000 prompt tokens (0.50 and 2.50 USD per 1M).
5. **Under-counted tokens:** Hermes's summary request after the iteration cap, and its
   non-streaming 5xx probe, are not in any `api_call` event (DESIGN 11 entries 6 and 7).
   Session totals equal the sum of the events in every run observed, so auxiliary calls, if
   Hermes makes any against OpenRouter, are in neither (A-7).
6. **D-8 is checked on writes to `experiment.status` only.** A trial that turns `errored` under
   an already `completed` experiment is not blocked. The scheduler (P3) derives the status.
7. **`trial_attempt.result` is nullable** (NULL while the dispatch is in flight), because
   DATA_MODEL 2.8 asks for the row before the HTTP call and lists no in-flight value.
8. **The memory fixture is small:** `MEMORY.md` 731 characters and `USER.md` 150, about 320
   tokens at 2.75 characters per token, against the roughly 800 tokens per call DESIGN 10.1 H3
   assumes. DESIGN allows "under 2,000 characters"; H3's cost figure should be re-estimated in
   P5, or the fixture enlarged before the real run.
9. **The adapter registers hooks through `PluginManager._hooks`, a private attribute,** and
   sets 2 environment variables Hermes reads (`HERMES_YOLO_MODE`, `HERMES_STREAM_RETRIES`).
   Pinned to `f4ac0bea1e`; a Hermes bump must re-run the conformance suite.
10. **Linux kill-race:** after a normal child exit the runner calls `killpg` on the child's
    process group to reap stragglers; a pid recycled in that instant could be hit. Not fixed.
11. **ESLint and Prettier were not run.** The build and the tests are clean.
12. **The stub-model walk is skipped inside the api container** (no Python there); it runs on
    a host with `E2E_PYTHON`. Gate 4 is the compose version of it.
13. **`npm audit` was not run; `npm install` reported deprecation notices** for `glob@10` and
    `eslint@9` (NestJS 11 scaffold dependencies).

### Assumptions resolved

- **A-1** Confirmed on the host (Windows, Python 3.14.4): `uv pip install -e` resolved every
  dependency including `nemo-relay` 0.10.4, no compiler needed. NOT verified on
  `python:3.14-slim` (no Docker); the card's fallbacks were not needed and not applied.
- **A-2** Confirmed. `run_agent`, `toolsets`, `hermes_constants`, `tools.memory_tool` and
  `tools.skills_sync` import after the editable install; no `PYTHONPATH` needed for Hermes.
- **A-3** Confirmed with 3 corrections. The nesting is as written and `agent.max_iterations`
  equals `max_steps` (`test_a3_...`). Strings must be quoted in the YAML (`coding_context:
  "off"`, `approvals.mode: "off"`): an unquoted `off` is a boolean in YAML 1.1. 3 keys were
  added: `tools.tool_search.enabled: "off"` (H-4), `agent.auto_recovery_cycles: 0` (M-3),
  `model.context_length` (the registry row's context window).
- **A-4** Checked early, formally P2: a bare agent does not seed `skills/`; the adapter calls
  `tools.skills_sync.sync_skills(quiet=True)` before constructing the agent and the `skills`
  toolset is then offered (`test_a4_...`). Preloading is not tested.
- **A-5** The string is `max_iterations_reached(N/M)` (`agent/turn_finalizer.py:138`), also
  `budget_exhausted`; both map to `max_steps`. Pinned by a source check and by the end-to-end
  cap test.
- **A-6** FALSE. `result["messages"]` has only user and assistant rows. Default applied, with a
  better source than the card's: the system prompt comes from the `pre_api_request` hook
  (equal to the request body the stub received) with `agent._cached_system_prompt` as the
  fallback, so `system_prompt_capture = True`.
- **A-7** Partly. Session token totals equal the sum of the main-loop `api_call` events (stub
  runs, and both real-key runs: 9,433/73 and 5,675/69). No auxiliary request reached the stub
  in any run. So auxiliary tokens are not in the totals; whether Hermes makes auxiliary calls
  against OpenRouter was not measured. Default applied: noted as a limit (item 5).
- **A-9** Confirmed. `GET https://openrouter.ai/api/v1/models` returns `data[]` with `id`,
  `context_length`, `pricing.prompt` and `pricing.completion` as USD per token strings, and
  `supported_parameters`. Values above.
- **A-11** Confirmed, on the stub (header `Authorization: Bearer <key>`, slug sent unchanged,
  `temperature` 0.0, `max_tokens` from `max_output_tokens`, `stream: true`) and against
  OpenRouter (both walks passed).
- **A-12** Confirmed. With `HERMES_YOLO_MODE=1` and `approvals.mode: "off"`, a recursive delete
  in the workspace ran with exit code 0 and no prompt (`test_a12_...`). `_floor_block` was not
  exercised.
- **A-13** Confirmed. With `run_budget_seconds` of 1 (start-up alone takes longer) Hermes still
  returned a normal result (`max_steps`, 3 steps). Only the runner kill bounds a trial.

### Next action

1. Install and start Docker Desktop; `docker compose version` must print a version.
2. `docker compose up -d --build`; `docker compose ps` must show db, api, worker and web
   healthy. If the worker image fails on the Hermes install, apply the A-1 fallbacks (add
   `build-essential`; then `--no-deps` minus `nemo-relay`) and report the pip output if that
   fails too (card section 9).
3. Gate 2: `docker compose exec api npm test` and `docker compose exec worker pytest -q`; both
   must exit 0 with the real database. Record N of N here. This is the first run of the Linux
   kill path.
4. Gate 4: `docker compose exec api node scripts/walk.mjs http://localhost:3000 model-b`
   (needs the real key in `.env`). Paste the 2 trial ids here and mark gates 2, 3, 4 and 5.
5. Then P2 (`cards/P2.md`).
