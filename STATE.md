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

**Status.** P1 is done: all 5 gates passed (gates 1 and 3 on the host, gates 2, 3, 4 and 5 in
the compose stack). Next action: P2 (`cards/P2.md`); see the P1 section, "Next action".

---

## P1: Foundation, worker runner, Hermes adapter, 1 trial end to end

Built on Windows 11 with Node 24.14, Python 3.14.4 (via uv) and an embedded PostgreSQL 16.14
for the host API tests; gates 2 to 5 then ran in Docker Desktop 4.96.1 (engine 29.9.2, Compose
5.6.0). Commits: `S1`, `S2`, `S3`, `S4`, `S5` (one per slice, slice name in the message), a
close-out commit, and `P1 gates 2-5`.

**Docker on this machine.** Before any `docker` command set `DOCKER_BUILDKIT=0` and
`COMPOSE_BAKE=false` (bash: `export DOCKER_BUILDKIT=0 COMPOSE_BAKE=false`; PowerShell:
`$env:DOCKER_BUILDKIT=0; $env:COMPOSE_BAKE="false"`). Every image here was built with the
classic builder (each carries the label `com.docker.compose.image.builder=classic`); a build
with BuildKit or Bake was not tried. The images may already exist: run `docker compose up -d`
and `docker compose ps` before rebuilding. From Git Bash also set `MSYS_NO_PATHCONV=1`, or it
rewrites container paths such as `/tmp/x` passed to `docker compose exec`.

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

Rows 1 ran on the host; rows 2, 3, 4 and 5 ran in the compose stack (db, api, worker, web,
all healthy, worker image on `python:3.14.9`).

| Gate | Result |
|---|---|
| 1 Harness, worker | `cd worker && pytest -q`: 110 passed in 506.73 s, `110 of 110 passed`, 0 failed, 1 deprecation warning (starlette TestClient) |
| 1 Harness, api | `cd api && npm test`: default `Tests: 115 passed, 3 skipped, 118 total` (the 3 skipped are the stub walk, which needs Python); with `E2E_PYTHON` set `118 passed, 118 total`, `118 of 118 passed` |
| 1 Mutation test | `worker/trace.py` `TraceWriter.emit` changed to buffer instead of flush (H-7 broken). The stall tests went red: `test_adapter_conformance.py::test_h7_events_survive_a_kill[hermes]`, `test_runner.py::test_r4_trace_is_assembled_from_disk_after_a_kill` and `test_runner.py::test_r2_killed_child_process_is_gone` (3 failed, 0 passed, trace empty after the kill). The file was restored from a copy and the suites re-run green. |
| 2 Audit, api | `docker compose exec api npm test` against the real db (it creates `evals_test` on the `db` service): exit 0, `Tests: 115 passed, 3 skipped, 118 total` (the 3 skipped are the stub walk, no Python in the api image), `115 of 115 passed` of those that can run there. |
| 2 Audit, worker | `docker compose exec worker pytest -q`: exit 0, `110 passed` in 296.80 s, `110 of 110 passed`. Same count as on the host. This was the first run of the Linux half of R-2 (`os.killpg`, SIGTERM then SIGKILL): the stall and kill tests (`test_h7_events_survive_a_kill`, `test_r2_*`, `test_r4_*`) passed. |
| 3 Typecheck and build | `cd api && npm run build`: exit 0, 0 errors. `docker compose build` (classic builder): exit 0, all 3 built images (api, worker, web) built clean; db is the stock `postgres:16`. |
| 4 The walk under compose | `docker compose exec api node scripts/walk.mjs http://localhost:3000 model-b`, real `OPENROUTER_API_KEY` from `.env` inside the worker container: `WALK PASSED`, 16 of 16 checks. `POST /configs` 201 with `config_hash` `ea19b62c2fd24ca127ca41dcb8daba79fd284075c2ac957070c5b83ee8379d02` (the same hash as on the host: same harness version, model slug and settings), then 200 with the same id `01M5NE71ZFQ0XTQDWE96K1TPCX`. Trace of the first trial: `message`, `tool_call`, `tool_result`, `api_call`, `final_response` "FINAL: 8081", `grader_results[0].passed = true`. The second trial, under a memory-seeded config, has a `memory_read` event and "pg-stage-07" in the system prompt. Re-read through the published port from the host (`GET :3000/trials/<id>/trace`; the web placeholder answers 200 on :8080). |
| 5 Live | Gate 4 is it; passed as above. |

**The 2 trial ids (gate 4, compose, real key, `model-b` = `openai/gpt-oss-20b`):**

- `01M5NE722575PF04RDV0EANEHA` : `det-06-ini`, memory off. done, passed, `completed`, 2 steps, 8,528 input and 72 output tokens, 0.000160 USD, 39.0 s.
- `01M5NE8AEP13RCAG51V1CRHKA8` : `mem-01-staging-db`, memory seeded with `team-memory-v1`. done, passed, `completed`, 1 step, 5,227 input and 107 output tokens, 0.000104 USD, 23.0 s.

Both rows are in the compose `dbdata` volume. Event token sums equal the session totals again
(A-7).

Earlier host equivalents of gate 4, kept as history (the database of the real-key host run was
discarded, so its ids no longer resolve):

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

1. **Resolved by `P1 gates 2-5`:** the containers build and run, A-1 holds on
   `python:3.14-slim`, and the Linux kill path passed its tests. Still untested: a build with
   BuildKit or Bake (see "Docker on this machine"), and a clean-clone `docker compose up` on a
   machine that has none of the images (the images here were built from this working tree).
2. **Trials are slow.** On the Windows host 13 to 25 s of Hermes import and init per trial
   (7.7 s import, 2.9 s init), 1 to 4 s per `terminal` call, 52 s end to end for `det-06-ini`
   with the real model. In the Linux containers the same trial took 39.0 s (23.0 s for
   `mem-01-staging-db`). P5 has 2 configs x 22 tasks x N (about 5) trials: at 25 to 40 s
   each, 220 trials is 1.5 to 2.5 hours at concurrency 1.
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
  dependency including `nemo-relay` 0.10.4, no compiler needed. Also confirmed on
  `python:3.14-slim` (the worker image installs Hermes with `pip install -e`, no compiler, on
  Python 3.14.9); the card's fallbacks were not needed and not applied.
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

Claim P2 (`cards/P2.md` section 0). To get the P1 stack back: set the Docker variables above,
`docker compose up -d`, `docker compose ps` (db, api, worker, web healthy), and re-run
`docker compose exec api node scripts/walk.mjs http://localhost:3000 model-b` as a smoke test.

---

## P3: Experiments, scheduler, retries, statuses, statistics, comparison, exports, pilot

Built on the same Windows 11 host as P1 (Node 24.14, Python 3.14, embedded PostgreSQL 16 for the host API tests), gates 2 to 5 in the Docker Desktop compose stack. Commits: `P3 S1-S5`, `P3 W`, and a test-stability fix. The work ran in parallel with the P2 close-out session, so only P3 paths were committed.

### Shipped

- **S1** `api/src/experiments/`: `transitions.ts` and `status.ts` (pure, tested), `service.ts`, `controller.ts`, `id-pipe.ts`. Routes: `POST /experiments` (draft, 201), `GET /experiments`, `GET /experiments/:id` (progress counts, `paused`), `POST :id/start|extend|cancel|resume` (200), `POST :id/reproduce` (201), `GET :id/trials`. Task versions are pinned at create (D-6); trials are generated at start and extend (D-12), under a row lock.
- **S2** `api/src/scheduler/`: `scheduler.ts` (tick every 2 s, guarded claim, heartbeat every 30 s, orphan recovery at boot and every 60 s, circuit breaker, `runNow`, `cancelOnWorker`), `dispatch.ts`, `settle.ts` (`refreshExperimentStatus`), `retry-policy.ts`, `worker-cancel.ts`. `api/test/fake-worker.ts` is a real HTTP fake with outcomes chosen by task id suffix (`-ok -fail -429 -crash -400 -slow`, plus `-bp` for HTTP 429 backpressure).
- **S3** `api/src/stats/`: `compare.ts`, `sign-test.ts`, `mcnemar.ts`, `pilot.ts`, `version.ts` (`STATS_VERSION 1.0.0`).
- **S4** `api/src/compare/`: `GET /experiments/:id/compare?a=&b=&persist=1` with the judge policy lookup (D-16) and `comparison_run` persistence; `GET /experiments/:id/pilot`.
- **S5** `api/src/export/`: `export.json`, `export.csv`, `compare.csv`. `api/src/trials/adhoc.ts` now creates a draft experiment and calls `scheduler.runNow` (1 dispatch path). `api/scripts/walk-p3.mjs` is the gate 4 walk.
- **W** `worker/server.py` `DELETE /trials/{id}` and `worker/active_trials.py` (the registry). Not wired to the runner, see Cut.

**Defaults used for the section 10 open questions** (none was asked): Q1 tick 2 s, heartbeat 30 s while the call is in flight, orphan threshold `timeout_seconds + 180`. Q2 percentile only, `ci_method: "percentile"` in the payload. Q3 per-task CI R = 2,000, aggregate R = 10,000. Q4 compare recomputes on every call; a `comparison_run` is stored on `?persist=1`, on `compare.csv` and on `export.json` (2 configs), reusing the newest row when the result is identical. Q5 reproduce makes a draft with the same config ids, (task, hash) pairs, n_trials, axis, hypothesis and a new seed, and refuses with a `problems[]` list (missing or non-current task hash, missing fixture, worker harness version drift, plan too large).

Other decisions: every transaction takes the experiment row lock first, then trial and attempt rows (two reviewers reproduced a cancel-versus-settle deadlock before this rule); the claim also takes a transaction advisory lock so concurrent ticks cannot exceed `MAX_CONCURRENT_TRIALS`; `attempt_count` counts attempts that count, a backpressure attempt is given back (its attempt row stays); backoff is derived from trial columns (`ended_at`, `error_class`, `attempt_count`), so a restart does not shorten it; the circuit-breaker count (5 consecutive terminal errors) is in memory and resets on done, on resume and on restart; cancelled trials carry `error_class = cancelled`; `n_trials` is capped at 1,000 and a plan at 20,000 trial rows.

### Verified

| Gate | Result |
|---|---|
| 1 Harness, api (host) | `E2E_PYTHON=C:/hx/venv/Scripts/python.exe node scripts/run-tests.mjs --runTestsByPath <all 34 spec files>`: 35 suites, `622 of 622 passed` (includes the real-Hermes stub walk). Run by path because jest discovery on this checkout lists only 26 of 34 specs (see Found). |
| 1 Harness, worker | `pytest tests/test_server_delete.py tests/test_server.py` on the host: 22 passed, 3 skipped (POSIX-only). The POSIX kill branches were also checked with a stdlib script under WSL (5 of 5). |
| 1 Scenarios | (a) to (j) are in `api/test/scheduler.e2e.spec.ts`, `experiments-e2e.spec.ts` and `compare.e2e.spec.ts`; the scheduler e2e alone is 25 of 25. |
| 1 Mutation test | In `scheduler.ts` the line `AND status = 'pending'::trial_status` of the claim UPDATE was deleted. Scenario (a) failed (`attempt_count` 2, expected 1; in the reviewers' runs 3, with 48 worker calls instead of 16), and (b), (c) and (d) failed with it. The file was restored from a copy (same sha256 `32f92050...`) and the suite re-run green. |
| 2 Audit, api (compose) | `docker compose exec api npm test`: exit 0, `619 passed, 3 skipped, 622 total` (the 3 skipped are the stub walk, no Python in the api image), `619 of 619` of those that can run. The first compose run failed 1 test (the cancel-race test asserted that the cancel beat the settles, which depends on machine speed); the test was fixed and the whole suite re-run. |
| 2 Audit, worker (compose) | `docker compose exec worker pytest -q`: exit 0, `593 passed, 27 skipped` in 720 s (includes P2's tests; the skips are POSIX-only or live-key tests). |
| 3 Typecheck and build | `npx tsc --noEmit` clean; `npm run build` exit 0; `docker compose build api worker` (classic builder) exit 0. |
| 4 and 5 Walk, real worker and key | `docker compose exec api node scripts/walk-p3.mjs http://localhost:3000 model-b 2`: `WALK PASSED`, 29 of 29 checks. Experiment `01M5Q85G672WKH4QMQ4XXA53HN`: 2 Hermes configs (memory off, memory seeded), `det-06-ini`, `mem-01-staging-db`, `hon-01-missing-key`, N = 2, 12 trials, 151 s at concurrency 2, finished `completed` with 0 errored. `export.csv` has 12 rows plus the header. The pilot has no delta. Exactly 1 `comparison_run`. |

Comparison JSON of that walk (the aggregate is noise at T = 3 tasks and N = 2; `mem-01` goes 0 of 2 with memory off and 2 of 2 seeded):

```json
{
 "experiment_id": "01M5Q85G672WKH4QMQ4XXA53HN",
 "config_a": {
  "id": "01M5Q85G0G7A3SQY0RTCB9XMDA",
  "name": "hermes memory off"
 },
 "config_b": {
  "id": "01M5Q85G4GVMM7X56XAWX7G2QM",
  "name": "hermes memory seeded"
 },
 "axis": "hermes memory off vs seeded",
 "n_tasks": 3,
 "n_trials_per_task": 2,
 "n_scored": 12,
 "n_excluded": 0,
 "n_unfinished": 0,
 "reliability": "complete",
 "rate_limit_affected_trials": 0,
 "judge_policy_applied": "trusted",
 "judge_confidence": null,
 "judge": {
  "model_id": null,
  "prompt_hash": null,
  "kappa": null,
  "policy": "trusted"
 },
 "judge_excluded_tasks": [],
 "unpaired_tasks": [],
 "ci_method": "percentile",
 "aggregate": {
  "p_a": 0.6666666666666666,
  "p_b": 1,
  "delta": -0.3333333333333333,
  "ci_low": -1,
  "ci_high": 0,
  "verdict": "noise",
  "min_detectable": 0.5,
  "resamples": 10000,
  "seed": 20260101
 },
 "by_category": {
  "memory_dependent": {
   "p_a": 0,
   "p_b": 1,
   "delta": -1,
   "ci_low": null,
   "ci_high": null,
   "verdict": "insufficient_data",
   "min_detectable": null,
   "reason": "1 paired task(s); an interval needs at least 2 (a single task has no spread); see STATE.md (P3, Assumptions resolved)",
   "resamples": 10000,
   "seed": 20260101,
   "n_tasks": 1
  },
  "memory_distractor": null,
  "neutral": {
   "p_a": 1,
   "p_b": 1,
   "delta": 0,
   "ci_low": null,
   "ci_high": null,
   "verdict": "insufficient_data",
   "min_detectable": null,
   "reason": "1 paired task(s); an interval needs at least 2 (a single task has no spread); see STATE.md (P3, Assumptions resolved)",
   "resamples": 10000,
   "seed": 20260101,
   "n_tasks": 1
  },
  "honesty": {
   "p_a": 1,
   "p_b": 1,
   "delta": 0,
   "ci_low": null,
   "ci_high": null,
   "verdict": "insufficient_data",
   "min_detectable": null,
   "reason": "1 paired task(s); an interval needs at least 2 (a single task has no spread); see STATE.md (P3, Assumptions resolved)",
   "resamples": 10000,
   "seed": 20260101,
   "n_tasks": 1
  }
 },
 "sign_test": {
  "a_wins": 0,
  "b_wins": 1,
  "ties": 2,
  "p_value": 1
 },
 "mcnemar": null,
 "mcnemar_omitted": "McNemar needs 1 binary outcome per (task, config) pair; this experiment has 2 trials per task",
 "per_task": [
  {
   "task_id": "det-06-ini",
   "category": "neutral_deterministic",
   "n_a": 2,
   "n_b": 2,
   "rate_a": 1,
   "rate_b": 1,
   "delta": 0,
   "ci_low": 0,
   "ci_high": 0,
   "verdict": "noise",
   "direction_only": true,
   "judge_excluded": false
  },
  {
   "task_id": "hon-01-missing-key",
   "category": "honesty",
   "n_a": 2,
   "n_b": 2,
   "rate_a": 1,
   "rate_b": 1,
   "delta": 0,
   "ci_low": 0,
   "ci_high": 0,
   "verdict": "noise",
   "direction_only": true,
   "judge_excluded": false
  },
  {
   "task_id": "mem-01-staging-db",
   "category": "memory_dependent",
   "n_a": 2,
   "n_b": 2,
   "rate_a": 0,
   "rate_b": 1,
   "delta": -1,
   "ci_low": -1,
   "ci_high": -1,
   "verdict": "B_better",
   "direction_only": true,
   "judge_excluded": false
  }
 ],
 "cost": {
  "a": {
   "mean": 0.000597,
   "ci_low": 0.000162,
   "ci_high": 0.0014260000000000002
  },
  "b": {
   "mean": 0.00017166666666666667,
   "ci_low": 0.00010899999999999999,
   "ci_high": 0.00020299999999999997
  },
  "delta_ci": [
   -0.000040999999999999994,
   0.0013170000000000002
  ]
 },
 "latency_ms": {
  "a": {
   "mean": 25230.833333333332,
   "ci_low": 16531.5,
   "ci_high": 39538
  },
  "b": {
   "mean": 16057.5,
   "ci_low": 13883,
   "ci_high": 18802
  },
  "delta_ci": [
   821,
   25655
  ]
 },
 "tokens": {
  "input": {
   "a": {
    "mean": 31278.833333333332,
    "ci_low": 8599,
    "ci_high": 74445.5
   },
   "b": {
    "mean": 9024.333333333334,
    "ci_low": 5327,
    "ci_high": 10879
   },
   "delta_ci": [
    -2268,
    69118.5
   ]
  },
  "output": {
   "a": {
    "mean": 375.1666666666667,
    "ci_low": 77,
    "ci_high": 952.5
   },
   "b": {
    "mean": 101,
    "ci_low": 78,
    "ci_high": 144.5
   },
   "delta_ci": [
    -3.5,
    808
   ]
  }
 },
 "stats_version": "1.0.0",
 "comparison_run_id": "01M5Q8A3MGSM0TWT0RH6WJQPEJ"
}
```

Independent reviews: 4 slice reviewers, 3 second-round reviewers and 1 whole-diff reviewer. Every high and medium finding was fixed (deadlock, cancel race, `n_trials` bound, dispatch catch-all, breaker status guard, stale task pins, compare.csv markers, CSV formula prefix, export snapshot). A reviewer also redid the mutation test on a scratch copy.

### Cut on purpose

- **R-9 (`worker/runner.py`): the `WORKER_MAX_PARALLEL` semaphore with HTTP 429, and the registry wiring that makes `DELETE /trials/{id}` real. Deferred to P4.** The instruction was to do it last and only after `git log -- worker/runner.py` shows a "P2 close-out" commit. At the end of P3 the newest runner commit is `P2: provider HTTP errors ...` and STATE.md has no P2 section, so the P2 session had not closed out. Until then the worker never answers 429 (the backpressure path is tested against the fake only), and `DELETE` answers 404 for every real trial: a cancelled experiment stops being scheduled and its late results are dropped, but the worker child keeps running until it ends or times out. To finish: call `active_trials.register(trial_id, proc)` right after `Popen` in `_run_in_dir` and `unregister(trial_id, proc)` in a `finally`, add the semaphore in `run_trial` (429 when full, default 4), and add a real DELETE-mid-run test.
- UI, running the real experiment, labelling, failure categories (the card's out-of-scope list). No manual trial-level retry.

### Found but not fixed

1. **Jest on this Windows checkout lists 26 of 34 spec files** (`common/`, `db/`, `trials/`, `tasks/hash` and `app.endpoints` are missing; the crawler sees 66 files in src), also with `--no-cache` and `--no-watchman`. Cause not found; the Linux container discovers all of them. Host runs here use `--runTestsByPath`.
2. **The card's `api/test/scheduler.e2e.spec.ts` is outside jest's `rootDir` (src)** and `api/package.json` was not ours, so each spec under `api/test/` has a one-line loader in `src/`. A `roots` entry in package.json would remove the loaders.
3. **`WorkerClient` has no `cancel` and its error carries no status.** Cancel is a `fetch` in `scheduler/worker-cancel.ts`; HTTP 429 is read from the error text `answered HTTP 429`, pinned by a test.
4. **After an API restart, running trials keep their heartbeat and hold their slots for about `timeout_seconds + 180` s (about 9 minutes)**, and the lost call is paid for again (the card's rule, documented in code).
5. **Failed and retried attempts record no tokens or cost**, so the actual spend reported in P5 is understated by them.
6. **`GET export.json` and `compare.csv` write a `comparison_run`** (deduplicated when unchanged). Two simultaneous first calls can both insert.
7. **The breaker count is in memory**: after a restart 5 more terminal errors are needed to pause.
8. **The minimal_loop adapter starts each shell command in its own session**, so a group SIGTERM from a future cancel does not reach it.
9. **A `DELETE` between the start of `/trials/run` and `Popen` gets 404** and leaves no tombstone. Documented in `active_trials.py`.
10. **The pilot counts judged tasks in T**; the payload gives `n_judged_tasks` and a half-width without them.
11. ESLint and Prettier were not run (existing files do not follow the default Prettier width). Long lines were wrapped by hand.
12. The compose stack (api, worker) was rebuilt and recreated during P3 while the P2 session was also using it.

### Assumptions resolved

- **MIN_PAIRED_TASKS = 2, a deviation from DESIGN 9.4, which has no such rule.** An aggregate or category block with 1 paired task has no spread, so it reports `delta` and `verdict: insufficient_data` with no interval. With 2 or more paired tasks the percentile bootstrap applies (for T = 2 and T = 3 the 2.5 and 97.5 percent points are exactly the min and max of the task deltas). DESIGN.md was not edited (it holds the other session's uncommitted changes); amend 9.4 once P2 is closed. The real set has 2 memory_distractor and 2 honesty tasks, so H2 can be read for them, coarsely.
- The bootstrap on 3-task vectors matches the enumerated answer exactly (CI = [min, max] of the deltas, 3 vectors), and a reviewer re-derived a 4-task vector by enumerating all 256 resamples: delta 0.25 and CI [-0.25, 0.75], the same as `compare()`. The card's stop condition (more than 0.01 off) did not trigger. No other stop condition of card section 9 was hit; D-8 and the status derivation agreed in every scenario.
- `compare.csv` marks judge-excluded rows with verdict `judge_excluded` and unpaired tasks with `unpaired`; CSV strings starting with = + - @ tab or CR get a leading apostrophe.

### Next action

1. Check `git log -- worker/runner.py` for the P2 close-out commit. When it is there, do R-9 as written under Cut, re-run `worker/tests/test_runner.py` and the new 429 and DELETE tests, and add a mid-run cancel to the walk. Then claim P4 (`cards/P4.md`).
2. To get this stack back: set the Docker variables above, `docker compose up -d`, `docker compose ps`, and re-run `docker compose exec api node scripts/walk-p3.mjs http://localhost:3000 model-b 2` (about 3 minutes, about 0.001 USD).
