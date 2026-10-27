# AUDIT_REPORT.md

Independent spec-to-code audit, read-only, run on 2026-10-26 against commit `e5b4599` (tree clean).
Scope: `api/`, `worker/`, `tasks/`, `experiments/`, the 4 documents and `cards/P1..P6`. **`web/` was skipped on the
owner's instruction (P7 runs in parallel); every UI-only requirement is marked DEFERRED and is outside the counts.**
Authority used: the assignment PDF (found at `C:\Users\NIRANJAN VSKS\Downloads\Agent Evals Platform_ Take-Home
Assignment (Applied AI Engineer).pdf`; `docs/ASSIGNMENT.pdf` does not exist in the repo), DESIGN.md, ADAPTERS.md,
DATA_MODEL.md, cards. `.env` and `.env.example` could not be read (denied by the session's permission settings).

---

## A. Run results

| step | command | result |
|---|---|---|
| build | `DOCKER_BUILDKIT=0 COMPOSE_BAKE=false docker compose build api worker` (web not built: P7) | exit 0; `Successfully tagged agent-evals-harness-worker:latest`, `agent-evals-harness-api:latest` |
| stack | `docker compose up -d api` (starts db and worker as dependencies, not web) | db, worker, api healthy; api start ran `prisma migrate deploy` (0003 applied to the default stack's database) |
| api tests | `docker compose exec api npm test` | exit 0. `Test Suites: 1 skipped, 36 passed, 36 of 37 total`; `Tests: 3 skipped, 703 passed, 706 total`. Skipped: `src/trials/stub-walk.e2e.spec.ts` (needs `E2E_PYTHON`, line 22 `describe.skip`) |
| worker tests | `docker compose exec worker pytest -q -rfs` | exit 0. `613 passed, 28 skipped, 1 warning in 891.67s`. Skips: 19 live judge tests (`RUN_LIVE=1`), 6 `test_task_set.py:248` "no fixture", 2 Hermes-only character-limit tests under minimal_loop, 1 `test_spec_isolation.py:55` (root can delete), others Hermes-only |
| P1 walk | `docker compose exec api node scripts/walk.mjs http://localhost:3000 model-b` | exit 0, `WALK PASSED`, 16 of 16 PASS. Trials `01M5TK1Z9QW41W9A7R9D9QJ6PN` (det-06, passed, 4,343/92 tokens, cache_read 4,288, 0.000086 USD) and `01M5TK2KCB161H3J92AG2PQ4NK` (mem-01 seeded, passed, memory_read present, 0.000104 USD) |
| P3 walk | `docker compose exec api node scripts/walk-p3.mjs http://localhost:3000 model-b 2` | exit 0, `WALK PASSED`, 27 PASS, 0 FAIL. Experiment `01M5TK3R3K3X4FF203K6P6GMPR`, 12 trials, `completed` in 211 s, aggregate -0.333 [-1, 0] `noise`, cancel check 2 running then `cancelled` 12 |
| extra | 2 x `GET /experiments/01M5TK3R3K3X4FF203K6P6GMPR/compare` | byte-identical bodies; `failures.a` = step_exhaustion 1, no_final_answer 1, uncategorized 0 |
| extra | psql on default stack after migration | 45 failed done trials, 43 with `failure_category` NULL; `trial_failure_category_iff_failed` `convalidated = f`; `judge_validation` 0 rows; `judge_label` 0 rows |
| errors | none in any command | the worker skip lines print host Windows paths (`C:\Users\...\worker\tests\test_judge_live.py`), so host `__pycache__` was copied into the image (`worker/.dockerignore:1` matches the root only) |

Spend of this audit: about 0.0012 USD (2 + 12 trials on model-b).

---

## B. Requirement table

Statuses: BUILT, PARTIAL, DIFFERS, MISSING, AMBIGUOUS. DEFERRED = UI-only, web skipped, not counted.

### B.1 Assignment

| ID | Source | Requirement | Status | Evidence | Gap |
|---|---|---|---|---|---|
| R1 | ASSIGNMENT | Hermes Agent is a harness | BUILT | `worker/adapters/hermes/adapter.py:119`; `worker/adapters/__init__.py:6`; P1 walk passed on Hermes | |
| R2 | ASSIGNMENT | A second harness behind the same abstraction | BUILT | `worker/adapters/minimal_loop/adapter.py:74`; conformance parametrized over REGISTRY (`test_adapter_conformance.py`) | |
| R3 | ASSIGNMENT | 2 models from different providers via a common interface | BUILT | `api/seed/models.json` (anthropic/claude-haiku-5.5, openai/gpt-oss-20b, OpenRouter); `worker/models.py:11` | |
| R4 | ASSIGNMENT | New harness or model is an adapter, not a core change | BUILT | REGISTRY 1 line `worker/adapters/__init__.py:6`; model 1 JSON row; `README.md:84-121` | UI side not audited; `worker/registry.py:10` lets an env var swap the registry (section E) |
| R5 | ASSIGNMENT | Deterministic graders: exact match, unit tests, state checks | BUILT | `worker/graders/exact_match.py:54`, `unit_test.py:54`, `file_state.py:101`, `trace_check.py:51` | |
| R6 | ASSIGNMENT | LLM-as-judge with a rubric | BUILT | `worker/graders/llm_judge.py:199`; tasks jdg-01..04, mem-06 | |
| R7 | ASSIGNMENT | Show the judge is trustworthy (agreement with human labels) | PARTIAL | tooling `api/src/judge/kappa.ts:79-186`, `sample.ts:35-44`; `experiments/judge-validation/sample.jsonl` 30 items | `labels.jsonl` absent (`ls experiments/judge-validation` = README.md, sample.jsonl); `judge_validation` 0 rows; DESIGN 10.4:645 "PENDING KAPPA" |
| R8 | ASSIGNMENT | Config = harness x model x settings (skills, memory, tools, temperature, step and token budgets) | BUILT | `api/src/configs/config-input.ts:7-24` | |
| R9 | ASSIGNMENT | Configs versioned so a past result is reproducible | BUILT | hash `config-input.ts:56-58`; immutability `0002_invariants/migration.sql:56`, `configs.controller.ts:28-34` | |
| R10 | ASSIGNMENT | Every task under every config, N repeated trials | BUILT | `api/src/experiments/service.ts:363-394`; P3 walk 12 = 2 x 3 x 2 | |
| R11 | ASSIGNMENT | Runs isolated, no leak between trials unless memory says so | PARTIAL | fresh child `runner.py:374-381`; fixture copy `runner.py:152-165`; R-10 `run_one.py:46-57`; tests R-1, R-5, H-2 pass | `/tasks` (all answers, `_hidden/`) mounted in the agent's container `docker-compose.yml:53`; DESIGN 13.6; secondary experiment read graders 7 of 66 model-a trials (export) before the R-10 fix |
| R12 | ASSIGNMENT | Timeouts, rate limits, retries, partial failures without corrupting results | BUILT | `runner.py:393-396`, `runner.py:206-233`, `retry-policy.ts:44-60`, D-8 trigger `0002:63-77` | no-status provider failures are scored, not retried (`runner.py:226-233`, DESIGN 11.17) |
| R13 | ASSIGNMENT | CIs and a paired test | BUILT | `api/src/stats/compare.ts:201-233`, `sign-test.ts:157-194`, `mcnemar.ts:125-145` | |
| R14 | ASSIGNMENT | Per-task deltas | BUILT | `compare.ts:318-334`; `compare.csv` 22 rows + aggregate | |
| R15 | ASSIGNMENT | Clear when a difference is noise | BUILT | `compare.ts:194-198`; payload `verdict` | |
| R16 | ASSIGNMENT | Cost, latency, tokens next to quality | PARTIAL | `compare.ts:366-385`, payload `cost`, `latency_ms`, `tokens` | cost excludes cached tokens: `ingest.ts:178` uses `input_tokens` only; walk trial in 4,343 vs cache_read 4,288; retried calls carry 0 tokens (DESIGN 13.9) |
| R17 | ASSIGNMENT | Trial inspection: messages, tool calls and results, memory reads and writes, skills, grader reasoning, score | BUILT | API: `trials.query.ts:17,61-86`; events `hermes/adapter.py:197,232,507,519`; `minimal_loop/adapter.py:133` | UI rendering DEFERRED |
| R18 | ASSIGNMENT | Failure categories (stretch) | PARTIAL | `api/src/failures/rules.ts:216-338` (12 rules), `0003_failure_category`, `backfill.ts` | 5 of 12 categories never observed (STATE P6); `grader_disagreement` needs labels that do not exist; default stack 43 of 45 failed trials uncategorized |
| R19 | ASSIGNMENT | TypeScript API and UI, Python worker allowed | BUILT | `api/` NestJS TS, `worker/` Python 3.14 (`python 3.14.9` in manifest) | UI language not audited |
| R20 | ASSIGNMENT | 1 command (`docker compose up`), keys via `.env` | PARTIAL | `docker-compose.yml:1-80`; `env_file: .env` line 45-46; db/api/worker came up | web not built in this audit; `.env.example` unreadable here; fresh-clone `up` never run (STATE P1 Found 1, P5 gate 4) |
| R21 | ASSIGNMENT | 20+ tasks, mix of grader types | BUILT | 22 task files; exact_match 10, file_state 4, unit_test 3, trace_check 1, llm_judge 5 (node count over `tasks/*.json`) | |
| R22 | ASSIGNMENT | Some tasks tell configs apart | BUILT | `compare.csv` primary: mem-01..05 delta -1 [-1,-1] | |
| R23 | ASSIGNMENT | Results persisted and exportable JSON or CSV | BUILT | `api/src/export/controller.ts`; P3 walk export.csv 12 rows, export.json 12 trials | |
| R24 | ASSIGNMENT | Document every assumption | BUILT | DESIGN.md 14 (A-1..A-13); STATE "Assumptions resolved" per phase | |
| R25 | ASSIGNMENT | README: setup, add a task, add a harness, add a model | BUILT | `README.md:21,68,84,99` | `README.md:8` claims "the judge checked against 30 human labels": false (R7) |
| R26 | ASSIGNMENT | Tested | BUILT | 703 api + 613 worker passing (A) | |
| R27 | ASSIGNMENT | Design doc: architecture, adapter interfaces, data model, isolation and reproduction, grader design and validation, statistics and N | PARTIAL | DESIGN 2, 3, 4, 6, 7, 8, 9 | grader validation results absent (8.2 protocol only) |
| R28 | ASSIGNMENT | Known limits | BUILT | DESIGN 13.1-13.14 | 13.6 stale (R72) |
| R29 | ASSIGNMENT | Cost formula, actual spend, reduction | BUILT | DESIGN 12.1, 12.2, 12.3; numbers match export (G) | |
| R30 | ASSIGNMENT | 1 experiment: hypothesis, setup, N, CIs, 2-3 trajectories, conclusion | PARTIAL | DESIGN 10.1-10.5; export `01M5SRTYPNZ9EWV1HX8KJGX40N.json` | 5 judged tasks and the 22-task headline "PENDING KAPPA" (DESIGN 10.4:582, 611, 645, 659) |
| R31 | ASSIGNMENT | Video of the working system, max 10 min | MISSING | only `VIDEO.md` (script) | no recording in repo; STATE P5 Found 9 |
| R32 | DESIGN 1 | Compare UI shows axis label or "multiple axes differ" | DEFERRED | web | |

### B.2 DESIGN.md

| ID | Source | Requirement | Status | Evidence | Gap |
|---|---|---|---|---|---|
| R33 | DESIGN 1, 9.4 | Noise iff 95% CI contains 0, applied in `compare.ts`, tested both sides | BUILT | `compare.ts:194-198`; `compare.spec.ts`; boundary run (F) | |
| R34 | DESIGN 2.1-2.2 | Worker has no database, API owns DB | BUILT | `worker/requirements.txt` (fastapi, uvicorn, pytest); no DB client in worker | |
| R35 | DESIGN 2.3, DATA_MODEL 2.8 | Attempt row written before the HTTP call | BUILT | `scheduler.ts:317` (create in claim tx) before `scheduler.ts:386` `runOnWorker` | |
| R36 | DESIGN 5 | Config hash covers harness id and version, slug, settings incl. fixture hash; name is not identity | BUILT | `config-input.ts:56-58`; `configs.service.ts:91-106`; walk "same body again -> 200, same id" | |
| R37 | DESIGN 5 | Adapter `validate()` at config creation, refusal with reasons | BUILT | `configs.service.ts:110-115` | |
| R38 | DESIGN 6.2 | `POST /experiments/:id/reproduce` refuses with what no longer resolves | BUILT | `experiments/service.ts:535-600`; `experiments.spec.ts:579,647` | |
| R39 | DESIGN 6.2 | Worker manifest with image digest when available | PARTIAL | `worker/server.py:56` reads `IMAGE_DIGEST` | compose never sets it; live manifest `"image_digest":null` |
| R40 | DESIGN 6.3 | Failure table: 429, 5xx, 4xx, no status, timeout, max_steps, crash, grader_error, backpressure, orphan, cancel | BUILT | `runner.py:206-233,404-499`; `retry-policy.ts:4-8`; `scheduler.ts:482-500`; `server.py:73-87` | |
| R41 | DESIGN 6.3 | Retry backoff 30, 60, 120 s up to 3 attempts | BUILT | `retry-policy.ts:15-17,53-57` | 120 s step unreachable at 3 attempts (`retry-policy.ts:10-11`) |
| R42 | DESIGN 6.3 | Circuit breaker after 5 consecutive terminal errors | BUILT | `scheduler.ts:21,445-469` | count in memory, resets on restart |
| R43 | DESIGN 6.3 | `rate_limit_events` counted and reported | BUILT | `ingest.ts:85-87`; `compare.ts:351-353` | |
| R44 | DESIGN 6.3 | `MAX_CONCURRENT_TRIALS` default 2 | BUILT | `scheduler.ts:88`; `docker-compose.yml:29` | |
| R45 | DESIGN 7.1, 7.3 | `exact_match` extracts last `FINAL:` line, fallback whole response | BUILT | `exact_match.py:16,38-41` | tolerates markdown (DESIGN 11, recorded) |
| R46 | DESIGN 7.2 | The 22 tasks of the table with the stated graders | BUILT | per-task grader list matches table (node over `tasks/*.json`) | |
| R47 | DESIGN 7.2 | Computed fixtures from seeded generators | BUILT | `tasks/gen/det_01_csv.py:20`, `det_07_sort.py:20`, `det_08_revenue.py:22` | |
| R48 | DESIGN 7.2 | MEMORY.md < 2,000 chars, USER.md < 1,200 | BUILT | 738 and 153 bytes (`wc -c`) | |
| R49 | DESIGN 7.4 | `tasks:sync` at startup, `tasks:lint` | BUILT | `tasks.service.ts`, `lint-cli.ts`, `sync-cli.ts` | |
| R50 | DESIGN 8.1 | Judge = registry row with role judge via `JUDGE_MODEL_ID`; not the candidate in the primary | BUILT | `judge/judge-model.ts`; export judge `model-a`, candidate `model-b` | |
| R51 | DESIGN 8.1 | Judge prompt versioned by hash, stored per grader row | BUILT | `llm_judge.py:43`; `grader_result.judge_prompt_hash` | |
| R52 | DESIGN 8.1 | Judge sees only declared inputs, never the trajectory | BUILT | `llm_judge.py:62-97` | |
| R53 | DESIGN 8.1 | Strict JSON, temperature 0, `pass` recomputed, 1 retry then `grader_error` | BUILT | `llm_judge.py:140,165-167,228-236` | model-a drops temperature on OpenRouter (DESIGN 13.2) |
| R54 | DESIGN 8.2 | 30 items, 6 per judged task, blind | BUILT | `sample.jsonl`: 30 lines, 6 per task, 0 forbidden keys at any depth | |
| R55 | DESIGN 8.2 | `judge:kappa`: agreement, kappa, bootstrap CI, writes row | BUILT | `judge/kappa.ts:79-186` | never run on real labels; seed not stored on row (F) |
| R56 | DESIGN 8.3 | Thresholds 0.6 and 0.4 to trusted, flagged, excluded | BUILT | `judge/policy.ts:4-22` | |
| R57 | DESIGN 8.4 | Policy applied before computing; payload states policy and excluded tasks | BUILT | `compare/service.ts:95-112,184-213`; `compare.ts:292,400-403` | |
| R58 | DESIGN 9.1 | Primary metric macro average over tasks | BUILT | `compare.ts:308` | |
| R59 | DESIGN 9.3 | Paired bootstrap over tasks, R = 10,000, seed stored on comparison_run | BUILT | `compare.ts:60,221`; `compare/service.ts:111,116` | |
| R60 | DESIGN 9.3 | Per-category deltas | BUILT | `compare.ts:311-315` | |
| R61 | DESIGN 9.4 | `min_detectable = (CI_high - CI_low)/2` | BUILT | `compare.ts:229` | |
| R62 | DESIGN 9.5 | Sign test, exact binomial, ties dropped | BUILT | `sign-test.ts:157-194` | |
| R63 | DESIGN 9.5 | McNemar only at N = 1, exact on discordant pairs | BUILT | `compare.ts:357-363`; `mcnemar.ts:143` | |
| R64 | DESIGN 9.5 | Per-task CI resampling trials within task, "direction only" | BUILT | `compare.ts:240-252,332`; `direction_only: true` | |
| R65 | DESIGN 9.5 | Cost, latency, tokens: mean of per-task means, task-level CI | BUILT | `compare.ts:366-385` | |
| R66 | DESIGN 9.6 | Comparison payload shape | DIFFERS | `compare.ts:138-173` | superset not in 9.6: `n_unfinished`, `judge_confidence`, `judge`, `unpaired_tasks`, `ci_method`, `mcnemar_omitted`, `failures`, `per_task[].direction_only/judge_excluded/failure_category_a/_b` |
| R67 | DESIGN 9.7 | Pilot: smallest N in {3, 5, 8} with h(N) <= 0.15, cap 8 | DIFFERS | `pilot.ts:123-128` searches every integer from n_pilot to 8 | gave 3 in P5 either way |
| R68 | DESIGN 9.7 | Pilot endpoint returns variances and widths, no delta | BUILT | `pilot.ts:40-62`; live pilot keys (A) | |
| R69 | DESIGN 9.7, D-9 | Full run extends the same experiment reusing pilot trials | BUILT | `experiments/service.ts:46,363-394` | not exercised in P5 (N = 3) |
| R70 | DESIGN 9.4 | Noise rule on any block (no minimum task count stated) | DIFFERS | `compare.ts:72,205-220` `MIN_PAIRED_TASKS = 2` gives `insufficient_data` | deviation recorded only in STATE P3; DESIGN not amended |
| R71 | DESIGN 10.1, D-10 | Hypothesis pre-registered, stored, immutable | BUILT | trigger `0002:97-111`; export hypothesis equals DESIGN 10.1 lines 506-513 byte for byte (609 chars) | |
| R72 | DESIGN 13.6, ADAPTERS 6 | Limits and runner invariants describe the current code | DIFFERS | DESIGN.md:1049 still says `../spec.json` is readable; `grep R-10 ADAPTERS.md DESIGN.md` no hit; code `runner.py:147-149`, `run_one.py:46-57` | docs stale after `6386959` |

### B.3 ADAPTERS.md

| ID | Source | Requirement | Status | Evidence | Gap |
|---|---|---|---|---|---|
| R73 | ADAPTERS H-1 | `validate()` rejects what it cannot honor | BUILT | `test_adapter_conformance.py:32-56` (class TestH1); `hermes/adapter.py:134`; walk-p2 skills refusal (STATE P2) | |
| R74 | ADAPTERS H-2 | Writes only under `trial_dir` | BUILT | `test_adapter_conformance.py:118` | watched paths only (DESIGN 13.4a) |
| R75 | ADAPTERS H-3 | Memory off: no content, tool or event; seeded: exactly the seed | BUILT | `test_adapter_conformance.py:136,148`; `hermes/adapter.py:220-250`; P1 walk memory_read + "pg-stage-07" | |
| R76 | ADAPTERS H-4 | Only configured tools offered | BUILT | `test_adapter_conformance.py:171,180`; `hermes/adapter.py:115` | |
| R77 | ADAPTERS H-5 | `prepare()` deterministic, idempotent | BUILT | `test_adapter_conformance.py:199` | |
| R78 | ADAPTERS H-6 | `run()` never raises for model or tool failures | BUILT | `test_adapter_conformance.py:222`; `hermes/adapter.py:264-267` | crashes become scored `agent_error` (section E) |
| R79 | ADAPTERS H-7 | Events flushed as they happen | BUILT | `test_adapter_conformance.py:233`; `worker/trace.py` | |
| R80 | ADAPTERS H-8 | `collect_memory()` from disk only | BUILT | `test_adapter_conformance.py:248,279` | |
| R81 | ADAPTERS H-9 | `steps` = count of ok `api_call` events | BUILT | `test_adapter_conformance.py:288,295` | |
| R82 | ADAPTERS H-10 | No adapter reads a key by name | BUILT | `test_adapter_conformance.py:309`; `hermes/adapter.py:242` | |
| R83 | ADAPTERS H-11 | `final_response` verbatim | BUILT | `test_adapter_conformance.py:327` | |
| R84 | ADAPTERS M-1 | No branch on model id or slug | BUILT | `test_adapter_conformance.py:314` (base.py excluded, DESIGN 11.2) | |
| R85 | ADAPTERS M-2 | Price snapshot copied per trial | BUILT | `scheduler.ts:293-308`; `price_snapshot` NOT NULL in 0001 | |
| R86 | ADAPTERS M-3 | `max_retries=0`, every retry an `api_call` event | BUILT | `worker/models.py:11-19`; `test_adapter_conformance.py:336` | Hermes 5xx probe residue (DESIGN 11.6) |
| R87 | ADAPTERS M-4 | Key never in spec, trace, log, DB | BUILT | `test_adapter_conformance.py:352`; `test_runner.py:187`; `runner.py:72-87` | |
| R88 | ADAPTERS R-1 | Fresh child process per attempt, minimal env | BUILT | `test_runner.py:12,20,28`; `runner.py:124-144` | `WORKER_REGISTRY` passes through (`runner.py:37`) |
| R89 | ADAPTERS R-2 | Kill at timeout + 60 s, SIGTERM then SIGKILL after 10 s, scored timeout | BUILT | `runner.py:55-56,90-110,393-396,451-486`; `test_runner.py:35,47,54` | |
| R90 | ADAPTERS R-3 | Exit without result = `worker_crash`, retryable | BUILT | `runner.py:488-499`; `test_runner.py:60,68` | |
| R91 | ADAPTERS R-4 | Trace assembled from disk | BUILT | `runner.py:404`; `test_runner.py:74,81` | malformed lines dropped silently (`trace.py:77-78`) |
| R92 | ADAPTERS R-5 | Fixture copied, never linked | BUILT | `runner.py:152-165`; `test_runner.py:94` | |
| R93 | ADAPTERS R-6 | Task hash re-verified, mismatch = `config_invalid` | BUILT | `runner.py:318-331`; `test_runner.py:103,112,118` | |
| R94 | ADAPTERS R-7 | Grading after `collect_memory`, hidden files after `run()` | BUILT | `run_one.py:67-81`; `test_runner.py:124,131` | |
| R95 | ADAPTERS R-8 | `trial_dir` deleted unless `KEEP_TRIAL_DIRS=1` | BUILT | `runner.py:340-345`; `test_runner.py:145,157` | |
| R96 | ADAPTERS R-9 | API bound plus worker 429 above `WORKER_MAX_PARALLEL` | BUILT | `runner.py:257-285`; `test_r9.py:59,72`; `retry-policy.ts:45-47` | |
| R97 | ADAPTERS 0 | TS mirror in `api/src/adapters/` | DIFFERS | actual `api/src/worker-client/types.ts:1-129`; no `api/src/adapters` (`ls api/src`) | naming only |
| R98 | ADAPTERS 2 | Worker `GET /adapters/{id}/validate` | DIFFERS | `worker/server.py:61` POST | recorded DESIGN 11.1; `base.py:115` docstring still says GET |
| R99 | ADAPTERS 3 | `memory_write.content_after` read by `collect_memory()` | DIFFERS | read in the hook at write time `hermes/adapter.py:513-520` | not recorded in DESIGN 11 |
| R100 | ADAPTERS 4 | Minimal loop: offered tools only, seed appended, 3 malformed calls = `invalid_tool_call`, temperature and seed sent | BUILT | `minimal_loop/adapter.py:74-413`; `test_minimal_loop.py` | 413 lines vs "about 150" (DESIGN 11.16); malformed broadened (DESIGN 11.12) |
| R101 | ADAPTERS 5 | Third model = 1 JSON row, no code | BUILT | `api/src/models/models.service.ts:16`; `README.md:99-121` | candidate role not enforced at config creation (C) |
| R102 | ADAPTERS 7 | Conformance suite over REGISTRY against stub server | BUILT | `worker/tests/test_adapter_conformance.py`, `stub_model_server.py`; passing (A) | |

### B.4 DATA_MODEL.md

| ID | Source | Requirement | Status | Evidence | Gap |
|---|---|---|---|---|---|
| R103 | DATA_MODEL D-1 | States are Postgres enums | BUILT | `0001_init/migration.sql:5-29`; `0003:4-17` | |
| R104 | DATA_MODEL D-2 | 1 current version per task id | BUILT | `0002:50`; `invariants.spec.ts:47-70` | |
| R105 | DATA_MODEL D-3 | Configs immutable (rule + 405) | BUILT | `0002:56`; `configs.controller.ts:28-34`; `invariants.spec.ts:72` | |
| R106 | DATA_MODEL D-4 | Unrunnable config refused | BUILT | `configs.service.ts:110-115`; `configs.spec.ts:114` | |
| R107 | DATA_MODEL D-5 | Fixture hash inside config hash | BUILT | `configs.service.ts:91-106`; `configs.spec.ts:93` | |
| R108 | DATA_MODEL D-6 | Experiments pin task hashes | BUILT | `experiments.spec.ts:106,129`; R-6 at the worker | |
| R109 | DATA_MODEL D-7 | Prices snapshotted per trial at dispatch | BUILT | `scheduler.ts:293-308` | |
| R110 | DATA_MODEL D-8 | `completed` impossible with an errored trial | BUILT | `0002:63-77`; `status.ts:35-43`; P3 walk check | checked only on experiment status writes (STATE P1 Found 6) |
| R111 | DATA_MODEL D-9 | `n_trials` only increases | BUILT | `0002:81-93`; `invariants.spec.ts:118` | |
| R112 | DATA_MODEL D-10 | Hypothesis and axis immutable after draft | BUILT | `0002:97-111`; `invariants.spec.ts:135-153` | |
| R113 | DATA_MODEL D-11 | `passed` set iff done | BUILT | `0002:31`; `ingest.ts:140` | |
| R114 | DATA_MODEL D-12 | Unique (experiment, config, task, index) | BUILT | `0001:274` | |
| R115 | DATA_MODEL D-13 | Errored implies error_class | BUILT | `0002:35`; `ingest.ts:111-113` | |
| R116 | DATA_MODEL D-14 | `trial.passed` = AND of grader rows | BUILT | `ingest.ts:141-152`; `dispatch.spec.ts:112` | no check that the grader row count equals the task's grader count (D) |
| R117 | DATA_MODEL D-15 | Labelling export blind | BUILT | `sample.ts:35-44`; `sample.jsonl` key scan | |
| R118 | DATA_MODEL D-16 | No validation row = excluded | BUILT | `compare/service.ts:198,208-209`; `policy.ts:253-258`; committed comparison_runs `excluded` | |
| R119 | DATA_MODEL D-17 | `failure_category` set iff done and failed | PARTIAL | `0003:24-40`; `ingest.ts:159-163`; `settle.ts:216` | CHECK stays NOT VALID where old failed rows exist: default stack 43 of 45 uncategorized, `convalidated = f` |
| R120 | DATA_MODEL 5 | export.json, export.csv (17 columns incl. `failure_category`), compare.csv | BUILT | `export/service.ts:9-31`; live header (A) | committed `*-trials.csv` have 16 columns (no `failure_category`) |
| R121 | DATA_MODEL 2.9 | Trace > 5 MB rejected, retried once | BUILT | `ingest.ts:13,155-157`; `dispatch.ts:139` `maxAttempts: 2` | |
| R122 | DATA_MODEL 2.13 | comparison_run stored on export | BUILT | `compare/service.ts:113-122`; P3 walk "exactly 1 stored comparison_run" | |

### B.5 Cards against DESIGN, and unclear text

| ID | Source | Requirement | Status | Evidence | Gap |
|---|---|---|---|---|---|
| R123 | P6 card vs DATA_MODEL 3 | Failure category list | DIFFERS | `cards/P6.md:50-61` 10 rules, `wrong_tool`, rule 5 = `is_error` only; `DATA_MODEL.md:327-329` and `rules.ts` 12, `wrong_tool_usage`, rule 5 also needs an error pattern | card not updated after architect decisions |
| R124 | P2 card vs DESIGN 11 | Hidden test files location | DIFFERS | `cards/P2.md:100` `fixtures/<id>/hidden/`; DESIGN.md:875-878 and `runner.py:157` `_hidden/` | |
| R125 | P2 card vs code | Task schema file | DIFFERS | `cards/P2.md:66,103` `api/src/tasks/schema.json`; code `api/src/tasks/task-schema.ts` (zod) | |
| R126 | P1 card vs code | Node version default | DIFFERS | `cards/P1.md:255` Node 20; `api/Dockerfile:1` `node:24-bookworm-slim` | recorded in STATE P1 |
| R127 | ASSIGNMENT 7 | "loop or step exhaustion" as a category | AMBIGUOUS | assignment text: "loop or step exhaustion"; code has `step_exhaustion` (`rules.ts:216`) and no loop detector short of the step cap | unclear whether a loop that ends before the cap must be its own category |

---

## C. UNSPECIFIED behaviour

| file:lines | what it does |
|---|---|
| `worker/registry.py:9-11`; `runner.py:37` | `WORKER_REGISTRY` env var replaces the adapter registry in server and child (section E) |
| `worker/run_one.py:41-57`; `runner.py:147-149,339` | R-10: spec written outside trial dirs, deleted by the child before `prepare()`, child refuses to start if trial dir holds extras |
| `api/src/stats/compare.ts:72-74,205-220,329-331` | `MIN_PAIRED_TASKS = 2` and `MIN_TRIALS_PER_SIDE = 2`; below them `insufficient_data` with no CI |
| `api/src/stats/compare.ts:398` | an unpaired, non-judged task makes `reliability: partial` |
| `api/src/stats/compare.ts:273,284` | a done trial with `passed = null` counted in `n_excluded` |
| `api/src/compare/service.ts:115-118` | persist dedupe: equal newest result reuses the old comparison_run id |
| `api/src/compare/service.ts:38,208-212` | across several judges the most restrictive policy wins; policy re-derived from stored kappa, ignoring the stored policy column |
| `api/src/judge/kappa.ts:17,80-82` | fewer than 30 labels: numbers printed, no validation row written |
| `api/src/experiments/service.ts:24,38,46` | caps: `n_trials` max 1,000, 20,000 new trial rows per call |
| `api/src/scheduler/retry-policy.ts:21,45-47` | backpressure re-queues capped at 100, then errored |
| `api/src/export/service.ts:35-36,92-93` | `?traces=1` refused above 2,000 trials |
| `api/src/configs/config-input.ts:33-53` | tools de-duplicated and sorted, `providers_ignored` sorted and de-duplicated before hashing |
| `worker/runner.py:72-76` | NUL characters stripped from every string |
| `worker/runner.py:299-306` | duplicate in-flight trial id answered 429; tombstone consumed before start |
| `api/src/trials/adhoc.ts:17` | every ad hoc experiment uses seed 1 |
| `api/src/trials/ingest.ts:204-215` | failure-rule exception stored as `wrong_answer` with `rule: 10` |
| `api/src/models/models.service.ts:16`; `configs.service.ts:76` | model `roles` validated on seed, but a `judge`-only model is accepted as a config candidate |

---

## D. Seam problems between phases

| # | Seam | Evidence | Problem |
|---|---|---|---|
| 1 | P6 payload vs P3 versioning | `stats/version.ts:2` `1.0.0`; `compare.ts:168` `failures` added by P6 | payload shape changed without a `STATS_VERSION` bump; committed comparison_runs (`experiments/results/*.json`) have no `failures`, live ones do; DESIGN 9.6 not updated |
| 2 | P6 columns vs P3 tables on existing databases | `0003:31-40`; psql (A): 43 of 45 failed uncategorized, CHECK not validated | any stack migrated from pre-P6 data runs with D-17 unenforced for old rows until `failures:backfill`; the compare payload reports them as `uncategorized` |
| 3 | P6 rule numbering vs ingest fallback | `ingest.ts:214` `rule: 10, category: 'wrong_answer'`; `rules.ts:305` rule 10 = `memory_ignored`, `rules.ts:337` rule 12 = `wrong_answer` | fallback evidence names the wrong rule |
| 4 | P6 rule 9 vs ingest | `ingest.ts:211` passes `[]` labels | `grader_disagreement` can only appear via backfill after labels; none exist |
| 5 | P6 histogram vs P3 judge policy | `compare.ts:337` counts headline tasks only | under policy `excluded` the largest real category (`judge_criteria_unmet`, 37 of 85 per STATE P6) is absent from every compare payload |
| 6 | worker TrialResult vs api ingest | `runner.py:431` `all(...)` over the returned list; `ingest.ts:141-152` checks non-empty and AND | no check that `grader_results.length` equals the task's grader count; a result missing a failing grader row would be stored as passed |
| 7 | P5 results vs current code | STATE P5 "built from `git archive cb7a46d`"; commits `639aa93`, `6386959` later | committed exports were produced before P6 and before the R-10 isolation fix; secondary model-a arm read graders (7 trials name `spec.json` in tool-call args, export scan) |
| 8 | P5 export files vs P6 CSV format | committed `01M5SRTYPNZ9EWV1HX8KJGX40N-trials.csv` header 16 columns; live `export.csv` 17 | committed CSVs and JSON trials carry no `failure_category`; STATE says the p5run DB was backfilled, the committed files were not regenerated |
| 9 | P5 data vs repo stack | STATE P5 Found 5; psql default stack has neither P5 experiment | no import endpoint; the experiment exists only in `p5run` volume and the SQL dump |

---

## E. Mock, stub, hardcoded data

No hardcoded pass rate, CI, p-value, kappa, cost or token figure stands in for a computed value: all come from trial and grader rows (`compare/service.ts:80-93`, `pilot` `service.ts:132-141`). No TODO, FIXME, HACK or `pass`-only body in source. No unseeded RNG in stats or grading.

| file:line | category | what | reachable in prod | impact |
|---|---|---|---|---|
| `worker/registry.py:10`; `runner.py:37`; `worker/.dockerignore:1-3`; `requirements.txt` (pytest) | selectable fake | `WORKER_REGISTRY=worker.tests.fake_registry` loads FakeAdapter (canned `FINAL: 8081`, fixed tokens); `tests/` is in the image | yes, via `.env` (`env_file`) | configs on harness `fake` would validate and produce fake results |
| `worker/adapters/hermes/adapter.py:264-267` | swallowed exception | any `run_conversation` exception becomes `agent_error` with no `http_status` | yes | scored as a failure, never retried (by DESIGN 11.17); outages lower pass rates |
| `worker/adapters/minimal_loop/adapter.py:283-304` | swallowed exception | connection errors after retries become status-less `agent_error` | yes | same |
| `worker/trace.py:77-78` | swallowed | malformed JSONL lines dropped | yes | `trace_check` sees fewer events; missing file gives `[]` |
| `worker/runner.py:455-456` | swallowed | `collect_memory` failure after timeout gives `{}` | yes | memory-based failure rules only |
| `api/src/trials/ingest.ts:213-215` | swallowed | rules exception gives `wrong_answer` | yes | category only |
| `worker/adapters/minimal_loop/adapter.py:197-198,292-293` | default | missing `usage` counted as 0 tokens | yes | silent undercount |
| `worker/adapters/minimal_loop/adapter.py:277-278` | invented status | `finish_reason: error` without code treated as 502 | yes | errored and retried instead of scored (DESIGN 11.17 says so) |
| `worker/server.py:56` | constant null | `image_digest` from unset `IMAGE_DIGEST` | yes | manifest never pins the image |
| `api/src/judge/kappa.ts:19,167-179` | constant seed | `KAPPA_SEED = 20261023` not stored on `judge_validation` | yes | CI reproducible only while the constant is unchanged |
| `api/src/scheduler/scheduler.ts:492` | default | orphan threshold falls back to 300 s | yes | detection timing only |

Status transitions: every `done` result needs at least 1 grader row and `passed` equal to their AND (`ingest.ts:138-153`); every errored path stores `passed = null` (`runner.py:179-192`). No path marks a trial passed without a grader result, except the count gap in section D row 6.

---

## F. Statistics verdict

Ran `/tmp/statcheck.js` against the compiled `dist/stats/*` in the api container, plus a host enumeration.

| check | verdict | evidence |
|---|---|---|
| Aggregate resampling unit is the task | PASS | `compare.ts:221` bootstraps per-task `[rateA, rateB]` pairs; 5-task vector gave CI [-0.3333, 0.6], identical to exact enumeration of all 3,125 resamples (host node script) |
| Per-task rows resample trials within task | PASS | `compare.ts:240-252,332` (A's and B's outcomes resampled separately, R = 2,000) |
| Percentile CI at 2.5 and 97.5 | PASS | `bootstrap.ts:52,68-69` alpha 0.05, quantile type 7 (`bootstrap.ts:23-29`); `compare.ts:251` |
| Noise rule inclusive | PASS | `compare.ts:196`; `noiseRule` on [0, 0.5] noise, [-0.5, 0] noise, [1e-17, 0.5] noise, [0.01, 0.5] A_better |
| PRNG seeded from a stored seed; 2 calls identical | PASS | mulberry32 `bootstrap.ts:8-17`; seed = `experiment.seed` (`compare/service.ts:111`), stored on comparison_run (`:116`); 2 `compare()` calls identical, different seed differs; 2 live `GET compare` byte-identical |
| Errored trials excluded before rates | PASS | `compare.ts:279,284`; synthetic errored A trial: `rate_a` stayed 1, `n_excluded` 1, `reliability` partial |
| Pilot returns no delta | PASS | `pilot.ts:40-62`; synthetic and live payload keys contain no delta, p_a, rate, verdict or ci field |
| Sign test exact binomial | PASS | `sign-test.ts:157-174`; binom(0,5) = 0.0625; A 1, B 7 gives 0.0703125 (matches primary payload) |
| McNemar only at N = 1, discordant, exact | PASS | `compare.ts:357-363`; omitted at N = 3 with reason; at N = 1 `{a_only 1, b_only 1, n_discordant 2, p 1}`; 1 vs 7 discordant gives 0.0703125 |
| Cohen's kappa against textbook vectors | PASS | `stats/kappa.ts:89-105`; 20/5/10/15 gives 0.4 (to 1e-15); 45/15/25/15 gives 0.130435 |
| Results come from real trial rows | PASS | `compare/service.ts:80-93` reads `trial` rows; committed payload numbers recomputed from export rows (G) |
| Pilot N rule as DESIGN 9.7 | FAIL (minor) | `pilot.ts:123` every integer, not {3, 5, 8} (R67) |
| Blocks with 1 task | FAIL against DESIGN 9.4 text | `compare.ts:205-220` `insufficient_data` (R70) |
| Kappa CI reproducibility from the row | FAIL (minor) | seed and resamples not stored (`kappa.ts:167-179`) |
| Kappa run on real labels | NOT RUN | no `labels.jsonl`; `judge_validation` 0 rows |

---

## G. Numbers check (DESIGN 10.4, 10.5, 12.2, README against `experiments/results/*`)

Recomputed by a node script over the export rows and `comparison_runs[0].result`.

| figure | claimed at | sourced from | match |
|---|---|---|---|
| 132 trials, 132 done, 0 errored, attempt_count 1 all, 0 rate-limited | DESIGN 10.4:545 | export trials | match |
| exit reasons 124 / 6 / 2 (both experiments) | DESIGN 10.4:547 | export trials | match |
| start 14:53:34Z, end 15:22:32Z | DESIGN 10.4:546 | `experiment.started_at/finished_at` | match |
| s2 0.0606; h 0.0840, 0.0651, 0.0514; h(3) T=17 0.0956 | DESIGN 10.4:557-558; STATE 0.095553 | 44 cells from export | match |
| aggregate 0.667, 0.980, -0.314, [-0.549, -0.098], B_better, min det 0.225 | DESIGN 10.4:577 | payload; `compare.csv` `__aggregate__` | match |
| memory_dependent 0/1, -1 [-1,-1]; distractor [0,0]; neutral 0.958, [-0.125, 0.125]; honesty 0.833/1, [-0.333, 0] | DESIGN 10.4:578-581 | payload | match |
| sign test 1 / 7 / 9 tied, p 0.0703 | DESIGN 10.4:584 | payload | match |
| per-task table 17 rows | DESIGN 10.4:594-610 | `01M5SRTYPNZ9EWV1HX8KJGX40N-compare.csv` | match |
| cost 0.000590 [0.000383, 0.000820] vs 0.000466 [0.000278, 0.000703], delta [-0.000101, 0.000398] | DESIGN 10.4:619 | payload | match |
| latency 27.5 [22.2, 33.2] vs 21.0 [17.3, 25.5], delta [1.6, 12.2] s | DESIGN 10.4:620 | payload | match |
| input tokens 30,673 vs 24,522, delta [-5,616, 20,410]; output 423 vs 272, [-0.4, 343] | DESIGN 10.4:621-622 | payload | match |
| calls/trial 5.23, 3.61; tokens/trial 27,068, 22,842; per call 5,178, 6,334; out 402, 286; cost 0.000523, 0.000437 | DESIGN 10.4:628-632; 12.2 | export trials | match |
| mem-6 vs other-16 splits (7.9, 40,137, 0.000778 / 1.5, 8,107, 0.000157; 4.2, 22,167, 0.000428 / 4.4, 28,367, 0.000542) | DESIGN 10.4:633-634 | export trials | match |
| 30 non-ok `api_call` events in 11 trials (8 A, 3 B) | DESIGN 10.4:638 | trace events | match |
| 0 memory-off trials with memory_read; 0 trials naming spec.json (primary) | DESIGN 10.4:640 | trace scan | match |
| mem-01 off: 72,522 input tokens, system prompt 9,443 chars, `FINAL: unknown:unknown`; seeded 11,588 chars, 5,331 tokens | DESIGN 10.4:652-653 | export trial rows | match |
| "first call differs by 1,133 to 1,137 tokens"; "1,136 per call" | DESIGN 10.4:662 | first ok `api_call` of trial_index 0 per task: 1,128 to 1,140 | mismatch on this pairing; DESIGN does not state which trials it paired |
| fixture 881 characters | DESIGN 10.4:662, 13.11 | MEMORY.md + USER.md = 881 chars (891 bytes, 10 non-ASCII) | match |
| 583 calls, 3,294,030 in, 45,433 out, 0.0634 USD, 1,801 reasoning, 0 cache reads | DESIGN 12.2:926-940 | export trials | match |
| judge 30 gradings, 30,724 in, 22,050 out, 0.0141 USD; total 0.0775 | DESIGN 12.2:947-948 | grader `details.usage` x 0.10/0.50 | match |
| harness_cost_usd 0.0835 | DESIGN 12.2:955 | export | match |
| 0.0704 and 0.261 USD at cheapest and dearest provider; 0.107 and 0.00081 estimate | DESIGN 12.2:933-953 | arithmetic on export totals | match |
| secondary aggregate 0.745, 0.667, +0.078 [0, 0.176] noise, min det 0.088; categories | DESIGN 10.5:685-689 | payload `01M5SWT8E3DRSWGNK6407TD3AN` | match |
| sign test 3 / 0 / 14, p 0.25 | DESIGN 10.5:691 | payload | match |
| calls 3.27 vs 5.39; latency 22.2 vs 32.7, [-16.8, -4.8]; cost 0.000348 vs 0.000384, [-0.000157, 0.000103]; 9 input tokens per trial | DESIGN 10.5:694-695 | payload and export | match |
| cache reads 1,223,265 and 699,574; 0.0236 / 0.1459 / 0.0576 and 0.0224 / 0.0350 / 0.0244 USD | DESIGN 10.5:695 | export | match |
| 18 non-ok events in 7 secondary trials; 7 of 66 model-a trials opened spec.json | STATE P5; DESIGN 10.5:697 | trace scan: 7 trials name `spec.json` | match |
| secondary spend 0.0460 + 0.0150 = 0.0610; at most 0.181 / 0.196; Hermes 0.0820; both 0.139 | DESIGN 10.5:699 | export arithmetic | match |
| hypothesis text | DESIGN 10.1:506-513 | `experiment.hypothesis` | match (equal strings, 609 chars) |
| "the judge checked against 30 human labels" | README.md:8 | no labels file, 0 `judge_label` rows | mismatch |
| walk "about 0.0003 USD", "16 things" | README.md:59 | this audit: 0.00019 USD, 16 PASS | match |

---

## H. Top 10 risks a technical panel would probe

| rank | risk | evidence |
|---|---|---|
| 1 | The judge was never validated, yet README says it was; 5 of 22 tasks and the 22-task headline are missing | `README.md:8`; `experiments/judge-validation/` has no `labels.jsonl`; `judge_validation` 0 rows; DESIGN 10.4 PENDING KAPPA |
| 2 | Agents can read the graders: `/tasks` holds every answer in the agent's container; model-a read `spec.json` in 7 of 66 secondary trials | `docker-compose.yml:53`; DESIGN 13.6, 13.13; export scan; fix `6386959` closes `spec.json` only and post-dates the run |
| 3 | Cost is a floor: cached tokens priced at 0, retried calls carry no tokens, provider not pinned, registry price is an excluded provider's | `ingest.ts:178`; walk trial in 4,343 vs cache_read 4,288; DESIGN 12.2, 13.5, 13.14 |
| 4 | Thin evidence: N = 3, 17 scored tasks, the aggregate verdict carried by 5 tasks, 2-task categories with near-degenerate intervals, per-task deltas of single trials | DESIGN 10.4:587-588, 13.10; payload min_detectable 0.000 and 0.167 |
| 5 | Statistical choices not in the design document: `MIN_PAIRED_TASKS`, integer pilot search, payload drift without a version bump | `compare.ts:72`; `pilot.ts:123`; `version.ts:2`; DESIGN 9.4, 9.6, 9.7 |
| 6 | Infrastructure failures without an HTTP status are scored as agent failures and never retried | `runner.py:220-233`; `hermes/adapter.py:264-267`; DESIGN 11.17, 13.9 (2 primary trials ended on Hermes's notice) |
| 7 | Results are not reproducible from the repo stack: produced on an external stack from `cb7a46d`, no import endpoint, committed files lack P6 fields, fresh-clone `docker compose up` never run | STATE P5 Found 5, gate 4; section D rows 7, 8, 9 |
| 8 | A fake adapter is selectable in production through an env var, and tests ship in the worker image | `worker/registry.py:10`; `runner.py:37`; `worker/.dockerignore:1-3` |
| 9 | Failure analysis is heuristic and mostly unexercised: 5 of 12 categories never seen, `grader_disagreement` impossible without labels, default stack 43 of 45 failed trials uncategorized, abstention is a phrase list | STATE P6 Found 5 and follow-up (a); psql (A); `rules.ts` `ABSTAIN_PATTERNS` |
| 10 | Documents drift from code: DESIGN 9.4, 9.6, 13.6; ADAPTERS has no R-10 and says GET validate; P6, P2, P1 cards contradict the build; worker manifest never records an image digest | R66, R70, R72, R97, R98, R123-R126, R39 |

---

## I. Claims

**Safe to make (BUILT, with evidence):**

| claim | evidence |
|---|---|
| 2 harnesses behind 1 frozen contract; the conformance suite runs unchanged over both | R1, R2, R102; 613 worker tests pass |
| Adding a model is 1 JSON row; adding a harness is 1 directory plus 1 registry line | R4, R101 |
| Configs are content-hashed and immutable (DB rule and 405); experiments pin task hashes; prices snapshotted per trial | R9, R105, R108, R109 |
| Paired bootstrap over tasks, seeded and reproducible, inclusive noise rule, exact sign test, McNemar only at N = 1, pilot that never returns a delta | F (all PASS rows) |
| Every published number in DESIGN 10.4, 10.5 and 12.2 except the H3 first-call range is recomputable from the committed export | G |
| Hypothesis was stored before the run and cannot be edited after draft | R71 |
| Each trial runs in a fresh child process with a hard kill; timeouts are scored, crashes retried, provider HTTP errors classified | R88-R96, R40 |
| 22 tasks, 5 grader types; memory-dependent tasks separate memory off from seeded (0 of 15 vs 15 of 15) | R21, R22, G |
| Blind labelling sample of 30 items exists | R54 |
| 703 API tests and 613 worker tests pass in containers; both walks pass against the real model | A |

**Must be worded as limits or "in development":**

| claim | wording |
|---|---|
| Judge validation | "protocol and tooling built; labels and kappa pending"; remove README.md:8 claim |
| 22-task headline and judged-task results | "pending judge validation; headline over 17 deterministic tasks" |
| Isolation | "per-trial process and directory isolation; the agent's shell is not sandboxed and can read `/tasks`" |
| Secondary experiment (model-a vs model-b) | "model-a arm affected by a grader-file leak, fixed after the run; not re-run" |
| Cost and spend | "lower bound: cached tokens priced at 0, retries untracked, provider not pinned" |
| Failure categories | "rule-based, 7 of 12 observed in real data, grader_disagreement needs labels" |
| Reproducibility | "inputs pinned by hash; image digest not recorded; P5 data restorable only from the SQL dump" |
| `docker compose up` from a fresh clone | "not verified from a clean machine" |
| Video | "script only; recording pending" |
| UI behaviour (axis label, inspector rendering) | not audited here (web deferred to a separate pass) |

---

## Count per status

| status | count |
|---|---|
| BUILT | 104 |
| PARTIAL | 9 |
| DIFFERS | 11 |
| MISSING | 1 |
| AMBIGUOUS | 1 |
| total counted | 126 of 127 IDs |
| DEFERRED (web, not counted) | 1 |
