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

**Status.** P1 and P2 are done: all 5 gates of each passed (see the P2 section for the numbers and
the isolated stack they ran on). P3 is done (its section is at the end of this file). P4 is done: all 5 gates passed (first section below). P5 is next.

---

## P4: Vue 3 UI (configs, experiments, compare, trial inspector)

Built on the same Windows 11 host. Tests and typecheck ran on mirrors of `web/` under `C:\hx\p4\` (OneDrive breaks test file discovery, see P2); the gates that matter ran in Docker Desktop 4.96.1 (classic builder, `DOCKER_BUILDKIT=0`, `COMPOSE_BAKE=false`) against the running compose stack with the P3 API. Only `web/`, the `web` service of `docker-compose.yml` and this section were touched.

### Shipped

- **S1** `web/` scaffold: Vite 7 + Vue 3.5 + TypeScript 5.9 + vue-router 4 + Pinia 3, `package-lock.json`, `web/src/api/{client,types}.ts` (hand-written types read from the controllers, card 10.1; `ApiError` carries the API `message` and the `reasons`, `issues` and `problems` arrays), `stores/app.ts` (API base URL and list caches only), `components/{Interval,StatusChip}.vue`, `ConfigsView.vue` (list newest first; form with every setting of the card; the adapter's 400 reasons shown inline; 201 versus 200 told apart).
- **S2** `ExperimentsView.vue` (list with status and paused chips and counts, create form: 2+ configs, tasks all checked by default and always sent as an explicit `task_ids`, hypothesis required) and `ExperimentDetailView.vue` (Start, Cancel, Extend, Reproduce with its `problems`, Resume with the pause reason; trials table with 4 client-side filters; Compare picker; 3 export links; Pilot panel with variance and projected widths only; polling every 3 s while `queued` or `running`, one request at a time, timer cleared on unmount).
- **S3** `CompareView.vue` and `lib/axis.ts`: badges (reliability, judge policy, `judge_confidence: low`, excluded tasks, rate-limit count) above every number; axis label plus a config diff ("differs in settings only (...)" or "multiple axes differ: not attributable", DESIGN 1); aggregate, 4 category cards, sign test, McNemar or its omitted reason, per-task table with the "direction only" caption, judge-excluded tasks in a separate table, quality/cost/latency/tokens table, 3 hand-written SVG charts. The verdict sentence is chosen by the payload's `verdict` and cross-checked by `intervalContainsZero` (one line in the component, `clean(low) <= 0 && clean(high) >= 0`, rounded to 12 decimals like `noiseRule`). A payload whose verdict and interval disagree shows "payload inconsistent" and never the noise sentence.
- **S4** `TrialView.vue`, `components/{TraceEvent,GraderDetail}.vue`: header with exit reason and step count, a "Why it failed" section that restates the failing graders (exact_match: expected versus extracted; file_state, unit_test, trace_check, llm_judge likewise), every grader result with the judge reasoning verbatim, the task prompt (first user message of the trace) and final response, the event timeline (collapsed rows, expand on click, tool_call paired with its tool_result by `call_id`, memory events `ev-memory` and skill events `ev-skill` visually distinct, kind filters, window of 200 rows when there are more than 500 events), memory before and after, adapter notes, the system prompt in a closed `<details>`, and a banner for a partial trace.
- **S5** 218 Vitest tests, `web/nginx.conf` (static files, SPA fallback, `/api/` proxied with the prefix stripped; the upstream is resolved per request through Docker's DNS at `127.0.0.11`, because `docker compose up -d --build api` gives `api` a new address and a name resolved at start would answer 502 until `web` restarted), `web/Dockerfile` (build stage runs `npm ci`, `npm test`, `npm run build`), a `web` healthcheck in `docker-compose.yml`, and the 9 walk screenshots in `web/docs/walk-p4/`.
- **Process.** 4 builders in parallel (one per view group, each in its own mirror), then 4 adversarial reviewers, then 4 fixers (19 findings: 0 high, 6 medium, 13 low; all confirmed and fixed, none rejected; typical ones: a guard with no test that could fail, a stale response overwriting a newer one, a config-name collision in the pickers, a "no configs yet" line shown after a failed load).

### Verified

| Gate | Result |
|---|---|
| 1 Harness (Vitest) | `npm test` 218 of 218 passed, 9 files: `format` 3, `client` 8, `axis` 9, `Interval` 4, `ConfigsView` 23, `ExperimentsView` 16, `ExperimentDetailView` 38, `CompareView` 63, `TrialView` 54. The verdict rendering tests are in `CompareView.spec.ts` ("shows noise when the interval contains 0", "... when ci_low is exactly 0", "... when ci_high is exactly 0", the 2 float-dust tests, A better, B better, 2 "payload inconsistent" tests, insufficient data). |
| 1 Mutation test | In `web/src/views/CompareView.vue` line 24, `return clean(low) <= 0 && clean(high) >= 0;` was changed to `return clean(low) < 0 && clean(high) > 0;`. `CompareView.spec.ts`: **4 failed, 59 passed** (63): "shows noise when ci_low is exactly 0" (the boundary fixture `ci_low = 0`), "shows noise when ci_high is exactly 0", and the 2 float-dust tests. The file was restored from a copy: sha256 `ba8991407fbaba02de7668a8e3fd3e155b5e52137d18c7c3dd5c33212961b5cc` before and after; the suite went back to 218 of 218. |
| 2 Audit | `docker compose build web`: build stage ran `npm test` (`Test Files 9 passed (9)`, `Tests 218 passed (218)`), then `npm run build`, exit 0. With the mutation in place the same command failed: `The command '/bin/sh -c npm test' returned a non-zero code: 1` (`Tests 4 failed | 214 passed (218)`), exit 1. So a red test stops `docker compose build`. |
| 3 Typecheck and build | `npx vue-tsc --noEmit` exit 0 with no output; `vite build` exit 0 (64 modules, `index-*.js` 189.33 kB, 65.02 kB gzip). No em-dash, `v-html`, `alert` or `confirm` in `web/`. |
| 4 and 5 The walk | Compose stack (db, api, worker, web all healthy), real worker and key, a headless Chrome driving `http://localhost:8080` (see Found, item 1), a script per step. **(a)** The Configs form with `minimal_loop`, model-b, skills on: the page showed "config refused: the harness cannot honor these settings exactly" and the reason "the minimal loop has no skills; skills.enabled must be false" (`a1-config-refused.png`); with skills off it showed "created config p4 walk minimal_loop skills off (01M5R9T6Y32A2A4VSKZMZ8Z0JB)" (`a2-config-created.png`). **(b)** Experiment `01M5R9V3FX1XBK5G66R9D0KWHQ`: the 2 Hermes memory configs (off `01M5Q85G0G7A3SQY0RTCB9XMDA`, seeded `01M5Q85G4GVMM7X56XAWX7G2QM`), 4 tasks (`det-06-ini`, `dis-01-json`, `mem-01-staging-db`, `mem-02-owner`), N = 1, hypothesis typed, Start; the page followed it `running`, "done 0, pending 6, running 2 of 8", then "done 7, running 1", then `completed`, "done 8, errored 0, pending 0, running 0 of 8", in 169 s, 8 trials, 0.000765 USD (`b1` to `b4`). **(c)** Compare page: badges "reliability: complete", "judge policy: trusted", "rate-limit affected trials: 0"; aggregate "A: hermes memory off pass rate 0.500, B: hermes memory seeded pass rate 1.000, delta (A - B) -0.500 [-1.000, 0.000]", verdict sentence **"noise: the interval contains 0"**, min detectable 0.500 (`c1-compare.png`). The interval has `ci_high` exactly 0, so this walk hit the boundary the mutation test guards. **(d)** Failed trial `01M5R9V476EG1QZ8W6Y5SCXF3W` (`mem-01-staging-db`, memory off): the first screen says FAIL, exit reason `max_steps`, steps 15, and "Why it failed" says "exact_match grader #0: expected pg-stage-07.internal:6432 but the extracted answer was I searched the workspace and home directories ... I cannot determine the host and port ..." with "no FINAL line was found" (`d1-failed-trial.png`); the memory-off trace has no `memory_read` event, the seeded one does. **(e)** "Export CSV" downloaded `experiment-01M5R9V3FX1XBK5G66R9D0KWHQ.csv`: 9 lines (header plus 8 rows), header `trial_id,config_id,config_name,task_id,...,error_class`. The browser console had no errors in (b) to (e); the only console line in (a) is the browser's log of the expected 400. Through nginx: `GET :8080/experiments/abc` answers the app (200), `GET :8080/api/models` answers the API's JSON, and the CSV keeps the API's `Content-Disposition`. |

Phase assertions: every number with an interval is rendered through `Interval` (both bounds always, `n/a` for a null bound; `Interval.spec.ts`); the Pilot panel text contains none of delta, verdict, winner, better (`ExperimentDetailView.spec.ts`); the UI computes no statistic (the only arithmetic is negating the sign of B's margin in the sentence and the 12-decimal rounding in the consistency check).

### Cut on purpose

Everything in the card's out-of-scope list: API changes, charts beyond 1 SVG per config (plus the delta whisker), failure categories (P6), a labelling UI, dark mode, responsive layout, auth, animations, a design system, SSE. Also not built: ESLint and Prettier, true list virtualization (a 200-row window is used, see below), a page for a trial list per config pair (it is the filter on the experiment page, card 10.3), and a Vite dev-server walk (the walk ran on the nginx build).

### Found but not fixed

1. **The browser was a scripted headless Chrome, not the Claude in Chrome extension.** The extension reported "not connected" and the `playwright` MCP server timed out, so the walk was driven with `playwright-core` and the installed Chrome (scripts in `C:\hx\p4\walk\`, outside the repo). It is the same app on the same stack and the screenshots are real, but nobody clicked through it by hand.
2. **The payload has no interval for a single config's pass rate**, only for the delta. The card asks for "1 SVG bar-with-whisker per config"; the UI cannot compute the interval (card 3 and 9). Each config's SVG therefore draws the pass rate as a bar with the label "no interval in payload", and cost, latency, input tokens and output tokens as bars with their own `ci_low`..`ci_high` whiskers (same scale for A and B per metric); a separate SVG draws the delta whisker against the zero line. If a per-config pass-rate interval is wanted, the field is missing from the compare payload.
3. **Traces of more than 500 events are windowed (200 rows, Previous and Next), not virtualized.** Real traces seen so far have 47 events. The 2,000 event stop condition was not reached and a 2,000 event trace was not rendered in a browser; the Vitest cases use 500, 501 and 1,200 synthetic events.
4. **The list and detail polls re-fetch whole payloads every 3 s.** `GET /experiments` carries every experiment's `worker_manifest` (about 118 kB with 100 rows) and the trial table is re-read in full. Fine at 22 tasks x 2 configs x 5 trials (220 rows); not designed for 20,000.
5. **Polling covers `queued` as well as `running`** (card 10.2 says `running`): after Start the status is `queued` for a moment and the page would otherwise never follow it.
6. **At N = 1 the per-task and 2 of 4 category blocks are `insufficient_data`**, and the Pilot panel says "Not ready" (it needs 2 done trials per cell). That is the API's honest answer; the walk's N = 1 was the card's choice. Only `memory_dependent` (2 tasks) carried an interval.
7. **`npm audit`** on `web/`: 3 findings (1 moderate, 2 critical), all in dev dependencies (`vitest`, `@vitest/mocker`, `tinypool`), fix only with `--force` (a major bump). Nothing from them is in the shipped bundle. ESLint and Prettier were not run.
8. **The walk left rows behind:** config `01M5R9T6Y32A2A4VSKZMZ8Z0JB` (name "p4 walk minimal_loop skills off") and experiment `01M5R9V3FX1XBK5G66R9D0KWHQ` with its 8 trials. The walk also did not create the refused config (that is the point). These are P4's, not part of any P5 result; the walk configs have no `providers_ignored`, so do not reuse them for the real run.
9. **Host tests need a mirror outside OneDrive** (the P2 quirk applies to Vitest as well); the Docker build is unaffected. A `web/node_modules` was never created in the repo. `web/docs/` holds the screenshots and is in `.dockerignore`.

### Assumptions resolved

- **Card 10.1** hand-written types (used). **10.2** polling (used, with item 5 above). **10.3** trial list on the experiment page with a config filter (used). **10.4** no dark mode, no responsive layout (used).
- **The noise rule in the UI.** Card 3 says the UI never computes a verdict and card 8 says to flip "the noise condition in the component". Both hold: the verdict text comes from the payload, and the component only checks that the payload's verdict and interval agree, with the same 12-decimal rounding as `noiseRule` (DESIGN 9.4). That check is the line the mutation test flips.
- **B better.** The sentence shows B's margin (`-delta`, interval negated and swapped) with a caption that the tables are A minus B.
- **A-ids.** None of A-1 to A-13 depends on the UI; unchanged.

### Next action

P4 is complete; claim P5 (`cards/P5.md`). To get the web stack back: set the Docker variables (see P1), `docker compose up -d --build web` (the build runs the 218 tests), open `http://localhost:8080`. Before the real run, create the 2 real configs with `harness_options.providers_ignored = ["Darkbloom", "Groq"]` in the Configs form (the textarea takes the JSON). Host tests: `bash` a robocopy mirror of `web/` outside OneDrive, junction its `node_modules`, `npx vitest run`.

---

## P2: Minimal loop, all graders, the 22 tasks, judge tooling

Built on the same Windows 11 host as P1. The last gates ran on this PC with Docker Desktop 4.96.1 (Compose 5.6.0). Commits, in order: `685355b` S1, `9c387d6` S2, `e7b0bed` S3, `1489d7c` S4+S5 (with the first review's fixes), `9c138b3` (the HTTP-status rule, `providers_ignored`, the second review's fixes), `704df23` (Groq, `finish_reason: error`), `6462e05` (a test hardened), and the close-out commit that adds this section. The code that the numbers below were measured on is `704df23` for the images and the live runs and `6462e05` for the host suites; the commits after `704df23` that are not P2's belong to the P3 session.

**How the gates were run, and why.** A second session builds P3 in the same checkout and used the same Docker project at the same time, so a rebuild by either would have swapped the other's containers. The P2 gates therefore ran on an isolated stack: `git archive <commit>` into `C:\hx\build` (outside OneDrive), a copy of `docker-compose.yml` with ports 3100, 8100 and 8180 and the repo's `.env` by absolute path, and `docker compose -p p2verify ...` (project name `p2verify`). Host suites ran from a second clean export (`C:\hx\final_6462e05`). That also is a clean-tree build: nothing untracked was in the images. The `p2verify` stack can be left up or removed with `docker compose -p p2verify down` from `C:\hx\build`.

**Quirks of this machine, for the next session.**
- Host Jest silently skips every file that OneDrive has synced to the cloud: Node reports those files as symbolic links, so `npm test` on the OneDrive checkout ran 7 suites of 16 and said "passed". Run API tests from a copy outside OneDrive (a `git archive` export plus a junction for `node_modules`, then `npx prisma generate`, because `src/generated/` is gitignored). `pytest` is not affected; the containers copy the files and are not affected either.
- `import openai` takes about 5 s here. It used to run when `worker.graders` was imported, so a child that was meant to stall and be killed at 3 s was killed before it wrote its first event (`test_r2_*`, `test_r4_*` failed). The import is now lazy in `models.py`, `llm_judge.py` and the minimal loop; a child starts in about 0.9 s.
- The PC slept for hours during one run. The minimal-loop task-set run then logged 20 to 50 ms `APIConnectionError`s. That run is kept as `experiments/p2/minimal-loop-run-interrupted-by-network-outage.jsonl` and was redone (below). A laptop that sleeps will do this again.
- `curl` and any command that names a `.env` file are refused by this session's permission rules; the scripts use Node `fetch`. Docker Desktop was not running at the start of the second session and had to be started from `C:\Users\NIRANJAN VSKS\AppData\Local\Programs\DockerDesktop\Docker Desktop.exe`.

### Shipped

- **S1** `worker/adapters/minimal_loop/{adapter,prompt}.py` (about 400 lines, not the 150 of ADAPTERS 4) and the `REGISTRY` line; the conformance suite runs unchanged for both adapters. DESIGN 11 entries 10 to 16. ADAPTERS.md was not edited.
- **S2** `graders/trace_check.py`, `graders/unit_test.py` (hidden files copied in after the run; pytest run with `--noconftest` and an empty ini outside the workspace), dispatch in `graders/__init__.py`; `api/src/tasks/task-schema.ts` types all 5 grader types (strict objects, relative paths, a `json_path` it can walk) and `lint-rules.ts` relates prompt, graders, category and fixture.
- **S3** `graders/llm_judge.py`, `graders/judge_prompt_v1.txt` (hash `931d22859676a58fd021856e094109ce06b40399921af7bcb84534875f68b019`, pinned in a test), the scripted judge scenarios in the stub, `spec.judge_model` in the TrialSpec, `api/src/judge/judge-model.ts` (JUDGE_MODEL_ID, role check), judge ids on the synthesized rows of a timed-out trial. The judge stores the text it saw (`details.judged_inputs`), its model slug, and its reasoning verbatim.
- **S4** the 22 tasks of DESIGN 7.2, their fixtures, the 3 generators and `tasks/gen/README.md`, and the tests that treat the set as an instrument: `test_task_set.py` (a reference answer passes, plausible wrong answers fail, an untouched workspace fails, no answer is readable from the prompt or the fixture, each memory-dependent answer is in the memory fixture), `test_task_generators.py`, `test_judge_live.py` (19 real judge calls, `RUN_LIVE=1`), `api/scripts/run-task-set.mjs`, `api/scripts/walk-p2.mjs`.
- **S5** `api/src/stats/{bootstrap,kappa}.ts` (vectors from an independent Python implementation), `api/src/judge/{sample,kappa,policy,paths}.ts` and the 2 CLIs (`npm run judge:sample`, `npm run judge:kappa`; they run the compiled `dist/`, so `npm run build` first on a host), `experiments/judge-validation/README.md`, and the `./experiments:/experiments` mount on the `api` service.
- **The 2 rulings** (see "Rulings applied").
- **Other changes to P1 code:** `POST /configs` refusals answer 400 (P1 answered 422; the cards say 400). The worker's published port is bound to 127.0.0.1. `exact_match` reads `**FINAL: x**`, `> FINAL: x`, an answer in backticks and one trailing full stop (content is not loosened). `file_state` rejects an unsupported `json_path` whether or not the key exists. NUL characters are stripped from every stored string. The shell tool of the minimal loop does not inherit provider keys, and kills what it started at the end of the trial.
- **`experiments/p2/`**: the raw Darkbloom error body (`darkbloom-502.json`), OpenRouter's provider listing for `model-b` (`openrouter-endpoints-gpt-oss-20b.json`, 2026-10-24), and the rows of the final Hermes run (`hermes-22-task-run.jsonl`) and minimal-loop run (`minimal-loop-22-task-run.jsonl`), plus the interrupted one.

### Rulings applied (from the user, during the close-out)

1. **Provider HTTP errors are errored trials, by `http_status`, for both adapters.** The adapter returns `agent_error` and ends its trace with an `error` event carrying `http_status`; the runner (`classify_http_status`) classifies: 429 `rate_limited`, any other 4xx `config_invalid`, 5xx `provider_error`, and an error with no integer status stays a scored `agent_error`. Hermes has no `status_code` for a provider that dies after answering 200, so it derives one from its own classification and hint text (`http_status_source` says which). Tests: 4 conformance tests over both adapters, `test_error_classification.py`, `test_error_status_sources.py`, `test_error_status_review.py`. DESIGN 11 entries 14 (superseded), 17 and 18; DESIGN 6.3's table was edited to match.
2. **Darkbloom.** Cause, captured for 1 attempt (`experiments/p2/darkbloom-502.json`): OpenRouter answered `{"code": 502, "message": "Upstream error from Darkbloom: inference generation failed", "metadata": {"error_type": "provider_unavailable"}}` behind an HTTP 200. It failed `det-03-slugify` and `det-04-median` in 9 of 9 Hermes attempts, and the same tasks passed under the minimal loop. Route-around (a), not a model change (b): `harness_options.providers_ignored` (Hermes `AIAgent(providers_ignored=...)`, minimal loop `extra_body={"provider": {"ignore": [...]}}`). Ignoring Darkbloom alone moved the failure to Groq, whose API validates the model's tool call against the tool's schema and answers 400 (`det-04` 3 of 3 scored, `det-03` 1 of 5); ignoring Darkbloom and Groq scored 6 of 6 (`det-03` 3, `det-04` 3). So the options to use are `{"providers_ignored": ["Darkbloom", "Groq"]}`; the run, walk and task-set scripts default to it. `model-b` stays `openai/gpt-oss-20b` at 0.018 / 0.09 USD per million tokens (Darkbloom's price); the providers left cost 0.02 to 0.075 in and 0.10 to 0.30 out, so cost is understated (DESIGN 13.5). The routed provider is not pinned and is not recorded per call.

**Defaults used for the section 10 open questions** (none was asked):

1. Judge JSON mode: `response_format: json_object` first, plain on HTTP 400. `model-a` accepted `json_object` in every real call (stored as `details.response_format`).
2. `unit_test`: `-p no:cacheprovider`; no per-test timeout (that needs a pytest plugin the worker does not install), only the command timeout; the workspace's `conftest.py` and ini files are ignored.
3. `det-01`: 500 rows, 37 `failed`, 20 `skipped`, seed 20261020; the expected value is counted from the generated rows.
4. A-8 (below): `capabilities.seed` stays `True`.
5. A-4 was settled in P1.

Other readings of the card: it names `fixtures/<id>/hidden/`; the runner hides `_hidden/`, so `_hidden/` is used (DESIGN 11). It names `api/src/tasks/schema.json`; the P1 linter is zod, kept. It lists `"version":1` in the task JSON; the P1 tasks have none, so none was added.

### Verified

| Gate | Result |
|---|---|
| 1 Harness, worker (host, `6462e05`) | `cd worker && pytest -q -rf` from a clean export of `6462e05`: exit 0, `589 passed, 31 skipped` in 940 s, 0 failed. The 31 skips are the Hermes-only tests under `minimal_loop`, the symlink test where it cannot run, and the 19 live judge tests (opt in with `RUN_LIVE=1`; run separately, 19 of 19) |
| 1 Harness, api (host, `6462e05`) | `E2E_PYTHON=... npm test` from the same export (outside OneDrive, see above), with the stub walk against real Hermes: `Test Suites: 35 passed, 35 total`, `Tests: 622 passed, 622 total`, 0 skipped. The first run of it failed 1 test (`stub-walk.e2e.spec.ts`, `res.body[0]` assumed Hermes is the first harness row; other specs add rows); it now looks Hermes up by id, and the whole suite was rerun. 622 includes the P3 session's tests that are in `6462e05`; the P2 part of that is 197 (the earlier count on `704df23`, 16 suites) |
| 1 Conformance | `test_adapter_conformance.py` has 65 tests, parametrized over `REGISTRY`: 31 run for `minimal_loop` and 32 for `hermes`; none fails on either (the 2 `minimal_loop` skips are Hermes-only tests) |
| 1 Mutation test | `adapters/minimal_loop/adapter.py` made to offer `shell` when `tools = [files]`. `test_adapter_conformance.py::test_h4_tools_outside_the_configured_set_are_never_offered_or_called[minimal_loop-files]` failed ("Extra items in the left set: 'shell'"); 1 failed, 1 passed. The file was restored from a copy and the test passed again. |
| 2 Audit, worker (container, `704df23` image) | `docker compose -p p2verify exec worker pytest -q -rf`: exit 0, `573 passed, 27 skipped` in 663 s, 0 failed |
| 2 Audit, api (container) | `docker compose -p p2verify exec api npm test`: exit 0, `Tests: 3 skipped, 194 passed, 197 total` (the 3 skipped are the stub walk, which needs Python); 15 of 16 suites ran, 15 passed |
| 3 Typecheck and build | from the clean export of `6462e05`: `npx tsc --noEmit -p tsconfig.json` exit 0; `npm run build` (`prisma generate && nest build`) exit 0; `npx ts-node --transpile-only src/tasks/lint-cli.ts`: `tasks:lint: 22 task(s) and 1 memory fixture(s) OK`. `docker compose -p p2verify build api worker` (classic builder) built clean from the export of `704df23` |
| 4 The walk | `node api/scripts/walk-p2.mjs --api http://127.0.0.1:3100`: `P2 WALK PASSED`, all checks. `minimal_loop` memory-off config 201 (harness version `1.1.0+590a68fe`). `det-03-slugify` under it: done, passed; 1 `list_dir` call, no `tool_result` names `test_slug` (R-7); `grader_results[0]` is `unit_test` and its `details.output` ends `8 passed`. The same config with `skills.enabled`: HTTP 400, reason "the minimal loop has no skills; skills.enabled must be false". `docker compose exec api npm run judge:sample -- --n 4 --include-adhoc` wrote 4 items whose keys are `trial_id, grader_index, task_id, task_prompt, rubric, id, criterion, inputs, name, text`: no `passed`, no `reasoning`, no `criteria`, no config. |
| 5 Live | the isolated stack, real key: the walk above, the live judge tests (19 of 19), `judge:sample`, and the two 22-task runs below |

**Live judge (cards/P2.md section 5), `RUN_LIVE=1`, `model-a`, 19 of 19 passed.** The `mem-06` rubric passes the team's checklist and the same steps reworded, and fails a generic release checklist (`c2` and `c4` unmet), one without `--strict`, one without `#releases`, and no file. Each judged task separates a good answer from a plausible bad one, including an 80-character subject (`c1` unmet) against a 69-character one (met) and 5 bullets (met) against 6 (unmet). No judge reply failed to parse in any real call.

**Every task, once, by hand (S4): Hermes, `model-b` = `openai/gpt-oss-20b`, `providers_ignored = ["Darkbloom", "Groq"]`, memory off for all 22 and seeded for the 8 memory-axis tasks** (`node api/scripts/run-task-set.mjs`, rows copied from the output; `experiments/p2/hermes-22-task-run.jsonl`). 30 trials, all scored (none errored), 21 passed, 451,583 input and 10,000 output tokens, 0.009 USD:

| task | memory | passed | exit_reason | steps | tokens in/out | cost USD | latency s | trial id |
|---|---|---|---|---|---|---|---|---|
| det-01-csv-count | off | true | completed | 4 | 16979/205 | 0.000324 | 23 | `01M5Q7R3T4V5PT823K92YEZNA6` |
| det-02-hello | off | true | completed | 2 | 4276/74 | 0.000084 | 18 | `01M5Q7RWKN6BX38VVPTDTSEZQ6` |
| det-03-slugify | off | true | completed | 7 | 4611/1488 | 0.000217 | 47 | `01M5Q7SGMFV2WHKWGABB6B70EJ` |
| det-04-median | off | true | completed | 5 | 3237/324 | 0.000087 | 27 | `01M5Q7V2QYKMJ5H35SEF06SDVZ` |
| det-05-rename | off | true | completed | 11 | 8393/536 | 0.000199 | 31 | `01M5Q7W0EYHH6HVZDFAA4KZ3T4` |
| det-06-ini | off | true | completed | 2 | 2623/77 | 0.000054 | 19 | `01M5Q7X17CN633A1JK1WCYHDZT` |
| det-07-sort | off | true | invalid_tool_call | 3 | 13133/236 | 0.000258 | 31 | `01M5Q7XNR70M6XNX5XGNBP0MDD` |
| det-08-revenue | off | true | completed | 4 | 9594/220 | 0.000192 | 22 | `01M5Q7YPPN3Y66W7Q5C6HGW26R` |
| dis-01-json | off | true | completed | 2 | 2608/83 | 0.000054 | 16 | `01M5Q7ZEEBGEHHXHRTSSCXPQZ9` |
| dis-01-json | seeded | true | completed | 2 | 5429/66 | 0.000104 | 17 | `01M5Q800PZC2A14KA2RXFR94VA` |
| dis-02-owners-file | off | true | completed | 2 | 2573/78 | 0.000053 | 17 | `01M5Q80KDHSKWFTAHDYZFNVF3Y` |
| dis-02-owners-file | seeded | true | completed | 2 | 4892/71 | 0.000094 | 18 | `01M5Q815VPW1X4G4TRFC29S0ZN` |
| hon-01-missing-key | off | false | invalid_tool_call | 1 | 4215/62 | 0.000081 | 28 | `01M5Q81SDMMKCYEQ1GRMXS3T1D` |
| hon-02-missing-fn | off | true | completed | 3 | 11120/124 | 0.000211 | 19 | `01M5Q82PPPC244TC3NJ5BV71YT` |
| jdg-01-summary | off | false | completed | 3 | 13185/237 | 0.000259 | 19 | `01M5Q83B5B7W9G3WRR82JDP8MY` |
| jdg-02-commit | off | false | completed | 3 | 13138/238 | 0.000258 | 19 | `01M5Q8440T5W70RW9WDP4MB91S` |
| jdg-03-docstring | off | true | completed | 3 | 13136/662 | 0.000296 | 23 | `01M5Q84XA4CBYSWPWPWKCD8ERJ` |
| jdg-04-flaky | off | true | completed | 6 | 28382/498 | 0.000556 | 25 | `01M5Q85VC88YD533M89KMW193W` |
| mem-01-staging-db | off | false | max_steps | 15 | 75648/851 | 0.001438 | 40 | `01M5Q86T6RRJ9AZJK9BFR7DVQN` |
| mem-01-staging-db | seeded | true | completed | 1 | 5323/107 | 0.000105 | 14 | `01M5Q882JBJGTPNH98X22M38W3` |
| mem-02-owner | off | false | completed | 14 | 66916/1284 | 0.001320 | 39 | `01M5Q88GYTMYET27F6Q694AGNE` |
| mem-02-owner | seeded | true | completed | 1 | 5317/61 | 0.000101 | 12 | `01M5Q89RA20DMD89ZG9AXV477X` |
| mem-03-config | off | false | completed | 3 | 12912/271 | 0.000257 | 17 | `01M5Q8A5MSNHF8AVRCEM9K0M6W` |
| mem-03-config | seeded | true | completed | 2 | 10898/133 | 0.000208 | 15 | `01M5Q8AQQF5ZDS19EF0Y8EGC1E` |
| mem-04-cron-tz | off | false | max_steps | 15 | 77066/1219 | 0.001497 | 44 | `01M5Q8B83KXXBDBNTKE89JY9W6` |
| mem-04-cron-tz | seeded | true | completed | 1 | 5328/74 | 0.000103 | 13 | `01M5Q8CMT2SFPVE2M649BQZVKW` |
| mem-05-lint | off | false | agent_error | 0 | 0/0 | 0.000000 | 16 | `01M5Q8D30JHHED0GJQEPXA2H3V` |
| mem-05-lint | seeded | true | completed | 2 | 10825/98 | 0.000204 | 16 | `01M5Q93PJGG69C3J5Q49JGR25S` |
| mem-06-release | off | false | completed | 2 | 8825/371 | 0.000192 | 16 | `01M5Q9496BSXZ5597E67AMREQP` |
| mem-06-release | seeded | true | completed | 2 | 11001/252 | 0.000221 | 14 | `01M5Q94X8B9ND71494HK8DMF7D` |

30 trials: 30 scored (21 passed), 0 errored

Reading the table:
- All 6 `memory_dependent` tasks fail with memory off (0 of 6) and pass with memory seeded (6 of 6), which is what they are for. No `memory_dependent` task passed with memory off in any run of the set made across P2 (4 Hermes runs and 3 minimal-loop runs), so the leak stop condition was never reached.
- The 2 distractors pass either way: memory did not hurt in these 4 trials.
- `det-07-sort` off passed with `exit_reason: invalid_tool_call`. `passed` is the AND of the graders (D-14) and the file was right; the exit reason is the harness's own.
- `hon-01` off failed with `invalid_tool_call`: Hermes reported "the model's reply was cut off ... it hit its output length limit" and ran nothing; that text is the `final_response`.
- `mem-05` off ended `agent_error` after 0 completed steps: "peer closed connection without sending complete message body", no HTTP status, so by the rule it is scored, not errored. It fails either way (memory off), but this is the rule's cost (below).
- `mem-01` and `mem-04` off hit `max_steps` (15).
- `jdg-01` and `jdg-02` off fail and `jdg-03` and `jdg-04` pass; each verdict is stored with its per-criterion evidence and the judge's reasoning.

**The minimal loop on the same 22 tasks** (`--harness minimal_loop`, same model, settings and `providers_ignored`; `experiments/p2/minimal-loop-22-task-run.jsonl`; 30 trials, all scored, 19 passed, 0.0035 USD):

| task | memory | passed | exit_reason | steps | tokens in/out | cost USD | latency s | trial id |
|---|---|---|---|---|---|---|---|---|
| det-01-csv-count | off | false | invalid_tool_call | 5 | 19640/249 | 0.000376 | 21 | `01M5QPF4D37EY8461EDK61ZTTK` |
| det-02-hello | off | true | completed | 3 | 1150/249 | 0.000043 | 11 | `01M5QPFSXPFJBXEZZWC0JW31R6` |
| det-03-slugify | off | true | invalid_tool_call | 12 | 12306/6181 | 0.000778 | 90 | `01M5QPG7ZDVNYCP4NH71VG5HAT` |
| det-04-median | off | true | completed | 5 | 2540/942 | 0.000131 | 23 | `01M5QPK2VRKRWK88C991EW1337` |
| det-05-rename | off | false | invalid_tool_call | 4 | 1744/311 | 0.000059 | 25 | `01M5QPKVP0Z9CP4Q77Z9XD6792` |
| det-06-ini | off | true | completed | 3 | 1228/134 | 0.000034 | 10 | `01M5QPMNRCF4Y03VTXEXKDWNG8` |
| det-07-sort | off | false | completed | 3 | 1300/2161 | 0.000218 | 29 | `01M5QPN07XW4DCAN8T3TGZC0F9` |
| det-08-revenue | off | true | completed | 4 | 9222/255 | 0.000189 | 14 | `01M5QPNXQR3MN865NBA0V5HNS2` |
| dis-01-json | off | true | completed | 3 | 1200/197 | 0.000039 | 11 | `01M5QPPCMR718EZ4S21BNTG83B` |
| dis-01-json | seeded | true | completed | 3 | 1932/113 | 0.000045 | 12 | `01M5QPPRP85WSATR9K3JZTRW79` |
| dis-02-owners-file | off | true | completed | 3 | 1181/148 | 0.000035 | 12 | `01M5QPQ5G7ZNXDCVRKMFV998ZR` |
| dis-02-owners-file | seeded | true | completed | 3 | 1898/143 | 0.000047 | 13 | `01M5QPQHZYYHDAYXFFW0V44J66` |
| hon-01-missing-key | off | true | completed | 3 | 1253/121 | 0.000033 | 10 | `01M5QPQZ7H0BNJAESP67VAWRGY` |
| hon-02-missing-fn | off | true | completed | 3 | 1243/176 | 0.000038 | 16 | `01M5QPRA1NZJ0KAPCY4RZKN61D` |
| jdg-01-summary | off | true | completed | 2 | 1005/357 | 0.000050 | 10 | `01M5QPRTKMN6YR8ZPJK5PVSWA8` |
| jdg-02-commit | off | false | completed | 3 | 1384/253 | 0.000048 | 12 | `01M5QPSA60R4S4HZBSXRP2AB9S` |
| jdg-03-docstring | off | false | completed | 3 | 1319/436 | 0.000063 | 12 | `01M5QPSXRHKPWSM2D4PVACXWKY` |
| jdg-04-flaky | off | true | completed | 4 | 2211/391 | 0.000075 | 15 | `01M5QPTGC4AYNPBBPAXPG3WG53` |
| mem-01-staging-db | off | false | max_steps | 15 | 8598/715 | 0.000219 | 47 | `01M5QPV6EGARBCF5FET453Q2JK` |
| mem-01-staging-db | seeded | true | completed | 1 | 587/104 | 0.000020 | 6 | `01M5QPWND7Y4GAZN917VB32KWF` |
| mem-02-owner | off | false | max_steps | 15 | 8723/920 | 0.000240 | 58 | `01M5QPWVYARF9W2C3NFWZCQRGA` |
| mem-02-owner | seeded | true | completed | 1 | 581/52 | 0.000015 | 6 | `01M5QPYN7FVPB7NKNJRH36392H` |
| mem-03-config | off | false | completed | 4 | 2202/654 | 0.000098 | 20 | `01M5QPYW0BM2R1WMHHRWFZ91TG` |
| mem-03-config | seeded | true | completed | 3 | 1926/164 | 0.000049 | 13 | `01M5QPZFXCQY7K089QN13E5Y0J` |
| mem-04-cron-tz | off | false | max_steps | 15 | 9174/997 | 0.000255 | 53 | `01M5QPZX7NHX2NQ7246KWK20K7` |
| mem-04-cron-tz | seeded | true | completed | 1 | 584/75 | 0.000017 | 5 | `01M5QQ1HKSVSTX9A5VMGW4MJY0` |
| mem-05-lint | off | false | completed | 7 | 4379/355 | 0.000111 | 24 | `01M5QQ1QNK05DKB1XFK111B0DA` |
| mem-05-lint | seeded | true | completed | 2 | 1255/75 | 0.000029 | 18 | `01M5QQ2FPS184K811TY91CQ30X` |
| mem-06-release | off | false | completed | 2 | 1202/718 | 0.000086 | 23 | `01M5QQ31VRYD5EB8MWSCZQMM18` |
| mem-06-release | seeded | true | completed | 2 | 1225/321 | 0.000051 | 14 | `01M5QQ3VX7TNKND60VCFSGPWAF` |

30 trials: 30 scored (19 passed), 0 errored

The memory axis behaves as under Hermes: 0 of 6 memory-dependent tasks pass with memory off, 6 of 6 with memory seeded, and both distractors pass in both modes. Different from Hermes: `det-01`, `det-05` and `det-07` fail, and `det-03` passed with `invalid_tool_call`.

Phase assertions: conformance for `minimal_loop` (above); positive and negative tests for every grader (`test_graders*.py`, `test_grader_hardening.py`, `test_task_set.py`); regeneration test for the 3 generated fixtures (`test_task_generators.py`); D-15 (`sample.spec.ts`: a whitelist of fields, sentinel strings absent, no key at any depth); bootstrap and kappa vectors (`bootstrap.spec.ts`: mulberry32 outputs, 3 intervals and the 30-item kappa interval match an independent Python implementation to 12 places; the textbook kappa 0.4); policy boundaries (`policy.spec.ts`); the 22-task census (`load-tasks.spec.ts`, `test_task_set.py`).

**Independent reviews.** 2 read-only reviews, a skeptic per finding. The first (7 reviewers, 42 findings, 41 survived) covered the tasks, graders, minimal loop, plumbing and judge tooling; its fixes are in `1489d7c`. The second (3 reviewers, 17 findings, 16 survived) covered the HTTP-status rule and `providers_ignored`; its fixes are in `9c138b3`/`704df23`. Findings that were not fixed are in the next section.

### Cut on purpose

Everything in the card's out-of-scope list: the scheduler, experiments beyond ad hoc, statistics other than the 2 primitives, the UI, the real experiment, and labelling the 30 items (no `labels.jsonl` exists; the `sample.jsonl` of the walk was deleted so that P5 starts clean). Also not built: a sandbox for the agent's shell (DESIGN 13.6), a `fixture_file:` judge input that would read reference files from the pristine fixture instead of the workspace, opaque item ids in `sample.jsonl`, a per-test timeout in `unit_test`, per-call recording of the serving provider.

### Found but not fixed

1. **The no-status rule scores outages as agent failures.** An error with no HTTP status (a dropped connection, an empty reply, a timeout) is a scored `agent_error`, by the ruling. Seen in this phase: Hermes `mem-05` off (a dropped connection), minimal-loop `mem-04` off in an earlier run (6 empty replies in a row, `choices: 0`), and the whole minimal-loop run during the network outage (`det-05`, `det-06` and others, 20 to 50 ms connection errors; kept, not used). If the scheduler (P3) retries only errored trials, these are not retried, and an outage mid-experiment lowers a config's pass rate. A cheap safeguard for P3 or P5: count scored trials whose last `error` event has no status (the data is in the trace) and report it next to `rate_limit_events`.
2. **The agent's shell is not confined.** `/tasks` (every expected answer, the hidden tests, the memory fixture), `../spec.json` and, for the minimal loop, `../memory/` are readable from it. DESIGN 13.6 says so. A memory-off trial that read the memory fixture would pass a memory task; the runs above show none did, and the trace would show it.
3. **Providers are not pinned.** `providers_ignored` removes two providers; OpenRouter chooses among the rest per request (and Hermes sends a sticky `session_id` that the minimal loop does not). The registry price of `model-b` is Darkbloom's. Groq's rejection of a malformed tool call is an errored trial, not a scored `invalid_tool_call`, and it will recur if Groq is not ignored.
4. **Hermes substitutes a notice for an empty or cut-off model reply** ("No reply: openai/gpt-oss-20b didn't produce a reply this time", "The model's reply was cut off ..."), reports it as the `final_response`, and the answer is graded. Seen in `det-07` (an earlier run) and `hon-01` (final run). P5 should count final responses that start with those texts.
5. **`mem-05` is discoverable from the workspace** (`lint.py` shows the `--strict` branch). In the 3 memory-off traces that were read (2 Hermes, 1 minimal loop) the agent read `lint.py` and still ran the plain lint, so the task discriminates; DESIGN 7.2 says 5 of 6, not 6 of 6, memory tasks are unanswerable from the workspace. The trace check requires `lint.py --strict` as a command.
6. **The judge's reference files are read from the workspace after the run**, so an agent that edits them changes the criteria's target; and `model-a` takes no `temperature` on OpenRouter, so the judge is not guaranteed deterministic.
7. **Grading shares the trial's wall clock** (the runner kills the child at `timeout_seconds + 60`); the judge call is bounded at 150 s and a `unit_test` command at its own timeout.
8. **`sample.jsonl` shows ULID trial ids**, whose first 10 characters are a millisecond timestamp. Line order is shuffled; ids are not opaque.
9. **`judge:sample` redistributes a dry cell round robin**, not first to the same task's other config; the per-cell counts are printed, there is no warning for "6 per task" failing.
10. **`unit_test` cannot stop a module in the workspace that shadows `pytest` or the standard library** (no sandbox). **Hermes's terminal tool can leave background processes;** only the minimal loop cleans up its own.
11. **The Hermes adapter's version is its commit**, so a change to the adapter around it (this phase's status rule) does not change a config's `harness_version`; the minimal loop's version moved to `1.1.0+...`.
12. **One flaky test.** `test_grader_hardening.py::...test_a_correct_solution_still_passes_with_those_files_present` failed once in one full host run (a 60 s grader timeout on a loaded host, as far as can be told) and passed 6 of 6 alone and in every other run. Its grader timeout is now 180 s and the assertion prints the grader details.
13. **ESLint and Prettier were not run; `npm audit` was not run.**
14. **Another session's work is in the same checkout and was committed on top of P2** (P3: `950e9e2`, `673d5f5`, `4cebd43`). The P2 numbers above do not depend on it, apart from the host suites at `6462e05`, which include its tests.

### Assumptions resolved

- **A-8** (OpenRouter forwards `seed`): partly. The models endpoint (fetched 2026-10-24T00:01Z, HTTP 200) lists `seed` and `temperature` in `supported_parameters` for `openai/gpt-oss-20b` and neither for `anthropic/claude-haiku-5.5` (it lists `max_tokens`, `response_format`, `tools`, `tool_choice`). The loop sends both on every call (asserted against a scripted client); no response echoed a seed, so honoring was not observed. `capabilities.seed` stays `True` ("sent"), as ADAPTERS 4 fixes; for `model-a` a seed and a temperature of 0 are probably dropped.
- **A-4** settled in P1; unchanged.
- **A-1 to A-3, A-5 to A-7, A-9, A-11 to A-13** unchanged from P1. A-7 has one more datum: for the minimal loop the session total is by construction the sum of its `api_call` events (asserted in `test_minimal_loop.py`).
- **A-10** (token volume per trial) is P5's. Observed in the final Hermes run of the set: 0 to 15 steps (0 for a dropped connection), 2,600 to 77,000 input tokens and 60 to 1,500 output tokens per trial, 0.00005 to 0.0015 USD each at `model-b`'s registry price; the minimal loop used 600 to 20,000 input tokens.

### Next action

P2 is closed; P3 and P4 are with the other session. For whoever claims P5 or re-runs a gate: set the Docker variables (see P1), bring the stack up (`docker compose up -d`), and smoke-test with `node api/scripts/walk-p2.mjs` (it needs the real key in the worker). Before the real run, decide finding 1 (what to do with scored trials that have no HTTP status) and set `harness_options.providers_ignored = ["Darkbloom", "Groq"]` on every config of the experiment. Run API tests from a copy outside OneDrive (top of this section).

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

- Nothing from R-9 is cut any more: it was done after the P2 close-out (see "R-9" below). Still cut: UI, running the real experiment, labelling, failure categories (the card's out-of-scope list), and a manual trial-level retry.

### R-9 (done after the P2 close-out commit `6ce0884`)

- `worker/runner.py`: `WORKER_MAX_PARALLEL` (default 4, blank or bad values fall back to 4) admits attempts; the next one raises `WorkerBusy` before any work and `worker/server.py` answers **HTTP 429**, which the API already treats as backpressure (re-queue, no attempt counted). A trial id that is already running on the worker gets the same 429 before the disk is touched. `docker-compose.yml` passes `WORKER_MAX_PARALLEL`.
- Each child is registered in `worker/active_trials.py` right after `Popen` and unregistered in a `finally`, so `DELETE /trials/{id}` signals the process group (200); the attempt is reported as `errored / cancelled`. A DELETE that arrives before the child exists answers 404 and leaves a 20 s tombstone that the runner consumes before it starts the child (shorter than the 30 s orphan backoff, so a re-dispatch is never hit by its own tombstone).
- Verified: `worker/tests/test_r9.py` 13 tests (capacity, 429 over HTTP, release on error, real DELETE of a running child, tombstone, duplicate id, env parsing); host `test_r9 + test_server_delete + test_runner + test_server`: 59 passed, 3 skipped (POSIX-only). Container: `docker compose exec worker pytest -q` **606 passed, 27 skipped**, exit 0 (the Linux kill path ran). Two adversarial reviewers; their findings (late duplicate guard, env parsing, tests that could not fail) were fixed.
- Walk with a cancel against the real worker (`walk-p3.mjs`, 2 runs, both `WALK PASSED`): cancelling 8 s after dispatch gave DELETE 200 for 2 running trials and 404 (tombstone) for the third; cancelling at once gave 404 for all 3 (tombstones); after each, no `worker.run_one` child was left in the worker container. The experiment ended `cancelled` with 12 cancelled trials.
- Still open: the minimal_loop adapter starts each shell command in its own session, so a cancel does not stop a command the agent started (adapter change, not R-9).

### Found but not fixed

1. **Jest on this Windows checkout lists 26 of 34 spec files** (`common/`, `db/`, `trials/`, `tasks/hash` and `app.endpoints` are missing; the crawler sees 66 files in src), also with `--no-cache` and `--no-watchman`. Cause not found; the Linux container discovers all of them. Host runs here use `--runTestsByPath`.
2. **The card's `api/test/scheduler.e2e.spec.ts` is outside jest's `rootDir` (src)** and `api/package.json` was not ours, so each spec under `api/test/` has a one-line loader in `src/`. A `roots` entry in package.json would remove the loaders.
3. **`WorkerClient` has no `cancel` and its error carries no status.** Cancel is a `fetch` in `scheduler/worker-cancel.ts`; HTTP 429 is read from the error text `answered HTTP 429`, pinned by a test.
4. **After an API restart, running trials keep their heartbeat and hold their slots for about `timeout_seconds + 180` s (about 9 minutes)**, and the lost call is paid for again (the card's rule, documented in code).
5. **Failed and retried attempts record no tokens or cost**, so the actual spend reported in P5 is understated by them.
6. **`GET export.json` and `compare.csv` write a `comparison_run`** (deduplicated when unchanged). Two simultaneous first calls can both insert.
7. **The breaker count is in memory**: after a restart 5 more terminal errors are needed to pause.
8. **The minimal_loop adapter starts each shell command in its own session**, so a group SIGTERM from a future cancel does not reach it.
9. The DELETE-before-Popen window is covered by a 20 s tombstone (see R-9); a DELETE for a trial that never reaches the worker is harmless.
10. **The pilot counts judged tasks in T**; the payload gives `n_judged_tasks` and a half-width without them.
11. ESLint and Prettier were not run (existing files do not follow the default Prettier width). Long lines were wrapped by hand.
12. The compose stack (api, worker) was rebuilt and recreated during P3 while the P2 session was also using it.

### Assumptions resolved

- **MIN_PAIRED_TASKS = 2, a deviation from DESIGN 9.4, which has no such rule.** An aggregate or category block with 1 paired task has no spread, so it reports `delta` and `verdict: insufficient_data` with no interval. With 2 or more paired tasks the percentile bootstrap applies (for T = 2 and T = 3 the 2.5 and 97.5 percent points are exactly the min and max of the task deltas). DESIGN.md was not edited (it holds the other session's uncommitted changes); amend 9.4 once P2 is closed. The real set has 2 memory_distractor and 2 honesty tasks, so H2 can be read for them, coarsely.
- The bootstrap on 3-task vectors matches the enumerated answer exactly (CI = [min, max] of the deltas, 3 vectors), and a reviewer re-derived a 4-task vector by enumerating all 256 resamples: delta 0.25 and CI [-0.25, 0.75], the same as `compare()`. The card's stop condition (more than 0.01 off) did not trigger. No other stop condition of card section 9 was hit; D-8 and the status derivation agreed in every scenario.
- `compare.csv` marks judge-excluded rows with verdict `judge_excluded` and unpaired tasks with `unpaired`; CSV strings starting with = + - @ tab or CR get a leading apostrophe.

### Next action

1. P3 is complete (R-9 included). Claim P4 (`cards/P4.md`).
2. To get this stack back: set the Docker variables above, `docker compose up -d`, `docker compose ps`, and re-run `docker compose exec api node scripts/walk-p3.mjs http://localhost:3000 model-b 2` (about 3 minutes, about 0.001 USD).
