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
the isolated stack they ran on). P3 is done (its section is at the end of this file). P4 is done: all 5 gates passed (first section below). P6 is built and stopped at its section 9 condition (its section follows P7). P5 has run: the primary experiment (N = 3, 132 trials, 0 errored) and the secondary are finished and committed, README.md, VIDEO.md and the DESIGN 10.4, 10.5 and 12.2 drafts are written; the owner's 30 labels were made and `judge:kappa` has run (kappa 0.6377, policy `trusted`; section "Judge validation", first after this one), so only the video is left. P7 (UI visual layer) is done: all 5 gates passed. P8 (home dashboard) is done: all 5 gates passed (its section is first).

---

## Judge validation: kappa, the 22-task headline, the exports and the dump (2026-10-27)

The owner's 30 blind labels (`experiments/judge-validation/labels.jsonl`, labeler `author`, committed in `306b1d8`) were joined to the judge's verdicts on the `p5run` stack, and everything that waited on kappa was filled. No code, test or UI was changed; documents, committed results and one dump only. The stack was the one P5, P6 and P8 left: its api and web were rebuilt from a working-tree copy for P8, so it already had migration `0004`, `STATS_VERSION` 1.1.0 and the 12 failure rules; its worker is still the old image.

### Shipped

- **Kappa.** `docker compose -p p5run -f C:/hx/p5src/docker-compose.yml exec -T api npm run judge:kappa` printed `judge model-a  prompt 931d22859676  labeler author`, `items 30  agreement 0.8333  kappa 0.6377  95% CI [0.321, 0.902]  policy trusted`, and wrote `judge_validation` `01M5XCC10GE09W7AZ68J681C23` (label set hash `6b0252dd...`). Confusion: judge PASS and human PASS 8, judge PASS and human FAIL 4, judge FAIL and human PASS 1, both FAIL 17. **The policy is `trusted`** (kappa at least 0.6, decided on the stored 4-decimal value).
- **`failures:backfill -- --sample 5`** on the same database: 85 failed trials examined, 1 updated, 84 unchanged, the CHECK `trial_failure_category_iff_failed` validated for every row. The one change is `01M5SRTYYG1J2AHXZX6RS871DG` (`mem-06-release`, seeded), which went from `judge_criteria_unmet` to `grader_disagreement` because the labeler passed what the judge failed. Histogram, all 85: `step_exhaustion` 10, `wrong_tool_usage` 6, `tool_error_unrecovered` 1, `no_final_answer` 5, `judge_criteria_unmet` 36 (was 37), `grader_disagreement` 1 (was 0), `abstained` 20, `wrong_answer` 6 (7.1 percent), the other 3 categories 0.
- **Re-export.** `node experiments/p5/fetch-results.mjs <id> http://127.0.0.1:3200` for `01M5SRTYPNZ9EWV1HX8KJGX40N` (new comparison run `01M5XCCARFCZ9QB07VGBZ62H08`) and `01M5STXWYMRDGQFJ47DNK5Y83S` (`01M5XCCEPKSFEYG1VR83YGVV31`); both print gate 5 `true`. The JSON, trials CSV (now 17 columns) and compare CSV of both are overwritten in `experiments/results/`; `comparison_runs[1]` is the new one (stats 1.1.0, policy `trusted`, 22 tasks, `failures`), `comparison_runs[0]` the pre-kappa one.
- **Dump.** `experiments/results/p5run-db-post-kappa.sql.gz` (680,816 bytes, `pg_dump --no-owner`). Restored into an empty `postgres:16` with `ON_ERROR_STOP`: exit 0; 264 trials, 2 experiments, 3 configs, 4 comparison runs, 30 `judge_label`, 1 `judge_validation`, 85 trials with a failure category, 4 migrations. `p5run-db-pre-kappa.sql.gz` was kept, not replaced (it is the database before the validation, 676,569 bytes).
- **Documents.** DESIGN 10.4 (status, headline over 22 tasks, "What kappa changed", per-task table with the 5 judged rows, cost and tokens table over 22 tasks, "Judge validation", conclusion), 10.5 (22-task table, sign test, fragility of the verdict, HS2, the same-config comparison), 10.6 (what the files are now); `README.md` (the judge sentence flipped as the docs section said; it quotes the interval); `experiments/p5/README.md` (the new dump); `cards/P6.md` §1 (the labels exist now). Every PENDING KAPPA in DESIGN.md is gone (`grep PENDING DESIGN.md` is empty).

### Verified

| Check | Result |
|---|---|
| kappa arithmetic | by hand from the confusion matrix: p_o = 25/30 = 0.8333; the judge says PASS on 12, the labeler on 9; p_e = (12 x 9 + 18 x 21) / 900 = 0.54; kappa = (0.8333 - 0.54) / 0.46 = 0.6377 |
| Exports equal the live API | `fetch-results.mjs` gate 5 for both: stored result equals a fresh `compare?persist=0`, field for field, `true` |
| The numbers in DESIGN 10.4 and 10.5 | the aggregate of each stored payload was reproduced to 4 decimals by calling the compiled `compare()` (`/app/dist/stats/compare.js` in the api container) on the export's trials with the same seed and policy `trusted`; the same call with policy `excluded` reproduces the pre-kappa 17-task row of 10.4 (0.6667, 0.9804, -0.3137, [-0.5490, -0.0980]) |
| Numbers not in a payload | the 8-task and 4-task neutral rows, the recomputation with human labels (the 30 trials' `passed` replaced by `human_passed`), the secondary without `jdg-04`, and the secondary with the 3 spec-reading passes scored as failures: all from that same `compare()` call on the same export. Scratch scripts, not committed |
| Restore of the new dump | above |
| Em-dashes in the text added to the documents | 0 |
| Tests, typecheck, build | **not run**: no code changed |
| UI | **not opened**, and `GET /summary` (the P8 Overview) was not read. The `p5run` web container serves the P7 and P8 UI; its Compare page should show policy `trusted` and 22 tasks, and P8 Found 3 ("judge: excluded" in the fail colour) should no longer apply. Nothing of that was looked at in this session |

### Cut on purpose

- No second labeler, no re-labelling (the card forbids it below 0.4 and nothing asks for it above).
- The committed `analyze.mjs` was not changed; it has no flag for the neutral_judged split. The two rows that need it were computed by a scratch script and are labelled as such in DESIGN 10.4.
- `VIDEO.md`, `ADAPTERS.md`, `DATA_MODEL.md` and older STATE sections were not edited (older sections say "waiting for the labels"; this section supersedes them).
- Nothing was committed.

### Found but not fixed

1. **The interval reaches below the `excluded` line.** Kappa 0.6377 [0.321, 0.902] is `trusted` by the point estimate; 0.321 is under 0.4. 30 items from 1 labeler cannot rule out an excluded judge. DESIGN 10.4 says so and does not use the interval.
2. **The judge's errors are all on 1 task.** All 4 false passes are `jdg-04-flaky` (judge 5 of 6, labeler 1 of 6); `mem-06` has the 1 false fail. Replacing the judge's verdicts with the labels on those 30 trials leaves the primary verdict at B_better (-0.318 [-0.515, -0.136]) and turns the `neutral_judged` row from B_better (-0.333) to noise (-0.167 [-0.500, 0.167]). The labels have no notes, so the reason for the `jdg-04` fails is unknown.
3. **The secondary's new A_better verdict (+0.106 [0.030, 0.197]) is fragile.** With the 17 non-judged tasks it is noise (lower bound exactly 0); with the 3 passes of model-a on `mem-05` and `mem-06` (all three opened `spec.json`) scored as failures it is +0.061 [0.000, 0.136], noise. Nothing validates the judge on model-a's own answers, and model-a is the judge. HS2's pass-rate half is "in direction, not in strength" in DESIGN 10.5.
4. **Policy `trusted` is applied to the secondary experiment by assumption.** The labels cover the primary's candidate only.
5. **The same config scored differently on 2 judged tasks across the 2 experiments** (`jdg-01` 1 of 3 then 3 of 3, `jdg-04` 2 of 3 then 1 of 3), while the 17 non-judged tasks match in all 17. The judged tasks are the noisier ones.
6. **`analyze.mjs` was run with `--reveal-judged`**; its output (`C:\hx\p5-analysis-final.txt`, `p5-sec-analysis-final.txt`) is outside the repo.
7. The limits in the older "Found" lists (Hermes retries, the confinement gap, cached tokens priced at 0, no import endpoint, no ESLint or Prettier run) still stand; none of them was touched.

### Assumptions resolved

- **Pre-registered policy rule (DESIGN 8.3):** kappa 0.6377 is at least 0.6, so `trusted`; the judge-graded tasks count in the headline and no separate table is needed. The 17-task numbers are kept in DESIGN 10.4 only as "before".
- **H1:** holds on 6 tasks (0 of 18 against 17 of 18, -0.944 [-1.000, -0.833]). **H2:** holds on the groups it names; the unregistered 4-task judged sub-group is B_better by the judge and noise by the labeler. **H3:** unchanged. Details in DESIGN 10.4.

### Next action

1. **Video** (owner): record on the `p5run` stack (<http://localhost:8280>) following `VIDEO.md`; the Compare page should show policy `trusted` and 22 tasks. Time it. Do not run `down -v` on `p5run`.
2. Review the diff and commit: `DESIGN.md`, `README.md`, `STATE.md`, `cards/P6.md`, `experiments/p5/README.md`, `experiments/results/*` (six regenerated files and the new dump).
3. Optional: rebuild the `p5run` api and worker images from a `git archive` of the commit (STATE "Audit fixes (code)", Found 1), so the stack is no longer built from a working-tree copy.

---

## P8: Home dashboard (1 read-only summary endpoint, 1 view)

Built on the same Windows 11 host in the OneDrive checkout. Host suites ran on a mirror outside OneDrive, `C:\hx\p8` (`sync.sh` there: robocopy of `api/`, `web/` and `tasks/` without `node_modules`, `dist`, `docs` and `src/generated`; `api/node_modules` a junction to the OneDrive one, `web/node_modules` a junction to `C:\hx\p6\wt\web\node_modules`, same `package-lock.json`; `npx prisma generate` run in the mirror, because the OneDrive `src/generated` predates migrations 0003 and 0004). The skills impeccable and ui-ux-pro-max were loaded before the view was written (Found 5). Every card section 10 default was used.

### Shipped

- **`GET /summary`** (`api/src/summary/`): `summary.service.ts` (pure helpers `macroMean`, `passOutcome`, `configRow`, `failureCounts`, `newestPerPair`, and `SummaryService`, which reads everything in 1 RepeatableRead transaction, `SNAPSHOT_TX` from `compare/service.ts`), `summary.controller.ts` (the controller and `SummaryModule`), `summary.spec.ts`. Shape, as card section 4 with 3 additions:
  - `totals`: `experiments`, `configs`, `tasks_current` (`is_current` rows), `trials_done`, `trials_errored`, `spend_usd` (sum of `cost_usd` over done trials), `models` (model rows), `harnesses` (distinct harness ids).
  - `latest_comparisons`: the newest `comparison_run` of each (experiment, A, B) pair, newest first, at most 5. Fields as the card plus `config_a_id`, `config_b_id` (the Compare link needs `?a=&b=`) and `stats_version` (a stored row can predate 1.1.0). The verdict, delta, interval and reliability are read from the stored `result.aggregate`; nothing is recomputed.
  - `configs`: every config, sorted by name. `pass_rate` is the macro average of DESIGN 9.1 (per task, the mean of the scored done trials; then the mean over tasks), the arithmetic of `compare.ts` for `p_a` and `p_b`. `mean_cost_usd`, `mean_latency_ms`, `mean_input_tokens` and `mean_output_tokens` use the same macro mean (as `compare.ts` does for its metrics). A done trial with `passed` null counts in `trials_done` and in the means but not in `pass_rate`. `memory_mode` is `settings.memory.mode`.
  - `failures`: every category in rule order (0 included), plus `uncategorized` only when a failed done trial has no category.
  - `recent_experiments`: newest 8; `n_trials` is trials per cell (as `GET /experiments`); `progress` is the same object `GET /experiments` returns (with `cancelled` and `total`).
- `api/src/app.module.ts`: `SummaryModule` registered (1 import line and 1 array entry). This file is outside the owned list (there is no other way to mount the endpoint); the owner accepted the change.
- **`web/src/views/OverviewView.vue`** at `/`, top to bottom: page head with Refresh and the load time; row 1, 6 totals in 1 surface split by hairlines (experiments with configs, models and harnesses beneath; trials done; spend as `0.11 USD` with the exact `0.109366 USD` beneath; best pass rate with the config name; errored trials; current tasks), count-up on first render; row 2, "Latest verdicts" as rows of 1 panel (experiment link, A vs B, axis, delta with its interval bar, verdict pill and the margin sentence, reliability and judge badges, stats version and time, "Open Compare" to `/experiments/:id/compare?a=&b=`); row 3, pass rate per config as horizontal SVG bars (sorted, value labels, best config in the accent) and mean cost (x, USD) against pass rate (y) as a labelled SVG scatter; row 4, failure categories as a bar list (non-zero rows, sorted, the rule on hover, the total) and the recent experiments in `DataTable` (status chip, `finished / total` with the progress bar, whole-row link). Empty state at 0 experiments: 2 sentences and a "Create a config" button to `/configs`. Fetched once on mount; no polling. Each verdict is checked against its interval exactly as `CompareView` does (copied, 12-decimal rounding): "noise" only when the interval contains 0, otherwise "payload inconsistent".
- `web/src/router.ts`: `/` is the Overview (the redirect to `/configs` is gone; `/configs` is unchanged). `AppShell.vue`: an "Overview" nav link first, the "Agent Evals" wordmark now links to `/` (was `/experiments`; asked for by the owner after the first commit), and its comment. `web/src/api/types.ts` (`SummaryPayload` and its parts) and `client.ts` (`api.summary()`).
- Tests: `summary.spec.ts` 8 (6 pure, 2 against the database); `OverviewView.spec.ts` 11.
- `web/docs/walk-p8/`: 7 screenshots (`dark-` and `light-` times `1440-overview` and `1024-overview`, `dark-1440-compare-primary`, `dark-empty`, `light-empty`), `walk-report.txt` and `walk-report-empty.txt`.

### Verified

| Gate | Result |
|---|---|
| 1 Harness, API | Mirror, `node scripts/run-tests.mjs` (embedded PostgreSQL 16, no `E2E_PYTHON`): `Test Suites: 1 skipped, 37 passed, 37 of 38 total`, `Tests: 3 skipped, 734 passed, 737 total`, exit 0: **734 of 734** that can run (the 3 skipped are the real-Hermes stub walk). Before: 726 (Audit fixes (code)); 8 new. A first full run, with Vitest running at the same time on this host, timed out 3 tests (1 in `compare.e2e.spec.ts`, 2 in `summary.spec.ts`, each over 60 s; the read-only test then saw 2 rows written late by the timed-out one); the rerun alone passed all of them. `npx tsc --noEmit` exit 0. |
| 1 Harness, web | Mirror, `vitest run`: **253 of 253**, 13 files: the 242 of P7, unchanged and green, plus 11 new. After the wordmark change (its href is now asserted in the routing test of `OverviewView.spec.ts`): 253 of 253 again, `vue-tsc --noEmit` exit 0. The `p5run` web container was not rebuilt for it. |
| 1 Mutation test | In the mirror, `pass_rate: macroMean(done, passOutcome)` was replaced by the raw mean of the scored trials. `summary.spec.ts`: **2 failed, 6 passed**: "pass_rate equals the p_a and p_b of compare.ts on the same trials" (expected 0.4444444444444444, received 0.3333333333333333) and the database test (expected 0.8333333333333334, Compare's `p_a`, received 0.8). Restored from a copy: sha256 `498d7b351b63c396c0d95e977cd596fceb16c4ea76022de88a5a16a0339d4541` before and after, equal to the OneDrive file; 8 of 8 again. |
| 2 Audit | `api/` and `web/` copied into `C:\hx\p5src` (robocopy), `docker compose -p p5run -f C:/hx/p5src/docker-compose.yml build api web` (classic builder): the web build stage printed `Test Files 13 passed (13)`, `Tests 253 passed (253)`, then `vite build`; exit 0. The web image was rebuilt the same way after each of 2 layout fixes found in the walk: same counts, exit 0. |
| 3 Typecheck and build | `vue-tsc --noEmit` exit 0; `vite build` exit 0 (CSS 40.96 kB, JS 226.61 kB, 76.80 kB gzip); API `tsc --noEmit` exit 0. 0 em-dashes and 0 en-dashes in `api/src` and `web/src` (ripgrep). |
| 4 and 5 The walk | A dump of the P5 database was taken first (`C:\hx\p8\p5run-pre-p8.dump`). `docker compose -p p5run ... up -d --no-deps api web` (db and worker untouched; the api applied migration 0004 at start). Headless Chrome through `playwright-core` (`C:\hx\p8\walk.mjs`) on `http://localhost:8280`, dark and light at 1,440 and 1,024 px: 4 of 4 pages with 0 px horizontal overflow, the right `data-theme`, Overview active in the nav, 0 console errors. Real totals: 2 experiments, 3 configs, 2 models, 2 harnesses, 264 trials done, 0 errored, spend 0.109366 USD, 22 tasks; best pass rate 0.894 (`hermes memory seeded`); 85 failed trials (judge_criteria_unmet 37, abstained 20, step_exhaustion 10, wrong_tool_usage 6, wrong_answer 6, no_final_answer 5, tool_error_unrecovered 1, as the P6 backfill). The primary experiment's card, followed through its own link to Compare, in both themes: interval `-0.314 [-0.549, -0.098]` on both, verdict `B better by 0.314 [0.098, 0.549]` on both, reliability complete and judge policy excluded on both. **Empty database:** the default stack is not empty (124 experiments) and was not wiped; an isolated project `p8empty` (`C:\hx\p8\empty\compose.yml`: fresh postgres, the new api and web images, no worker, web on 127.0.0.1:8380) showed the empty state in both themes, no tiles, 0 console errors, and "Create a config" led to `/configs`. Torn down with `down -v`. |

### Cut on purpose

- Everything in the card's out-of-scope list: no time filter, no polling (a Refresh button, card 10.3), no chart library, no metric beyond section 4.
- No route transitions or page-load choreography; the only motion is the existing count-up.

### Found but not fixed

1. **The Overview's config pass rate is not the Compare page's `p_a` or `p_b` for the P5 configs, by design, and labelled so.** It covers every done trial of the config in every experiment, judged tasks included; Compare covers 1 experiment and withholds the judged tasks under policy `excluded`. `hermes memory off` ran in both P5 experiments (132 trials): Overview 0.568, primary Compare 0.667. The bar chart's caption says this. The equality is exact when a config ran in 1 experiment with no judge exclusion (the database test). Excluding judged tasks here would need a judge policy per config, which is a property of a comparison, not of a config (card section 9), so it was not done.
2. **Verdicts exist only where a comparison was persisted.** The Compare page does not persist (`GET .../compare` without `persist`); exports do. The 2 P5 rows were written on 2026-10-25 under `stats_version` 1.0.0; their headline numbers equal today's live Compare (gate 4). The card prints the version.
3. **The 2 P5 verdicts read "judge: excluded"** in the fail colour: correct until the 30 labels exist.
4. `app.module.ts` was edited (Shipped) although it is not in the owned list; accepted by the owner.
5. **Skills:** impeccable reported `NO_PRODUCT_MD` and asks for a `PRODUCT.md` first; not written (outside the owned paths, as in P7 Found 4). ui-ux-pro-max's chart search gave: sorted bars with value labels, and a text alternative for the scatter (done as an `aria-label` listing every point). Its CLI needs `PYTHONIOENCODING=utf-8` on this host.
6. **`p5run` now runs this tree's api** (migration 0004 applied to the P5 database, and the audit-fix code); its worker is still the old image with the old compose mounts (Audit fixes (code), Found 1), untouched. The api and web images were built from a robocopy of the working tree, not from `git archive`.
7. Not done: ESLint, Prettier, a screen-reader pass. The walk was scripted headless Chrome (the playwright MCP server timed out at session start).

### Assumptions resolved

- No A-id. Card 10.1 (tie for best config): more done trials, then name; tested. 10.2 (scatter with 1 config): drawn with 1 labelled point (no special case in the code). 10.3 (polling): fetch on mount and a Refresh button; tested.
- Readings taken: "newest 5 from comparison_run" as the newest row of each (experiment, A, B) pair, so an older snapshot of a pair never sits next to its current one; "spend" as done trials only (card section 4); `n_trials` as trials per cell, as everywhere else in the API.

### Next action

P8 is done; nothing is committed. To rebuild `p5run` after a later change: robocopy `api/` and `web/` into `C:\hx\p5src` (or `git archive HEAD api web | tar -x -C /c/hx/p5src`), then `docker compose -p p5run -f C:/hx/p5src/docker-compose.yml up -d --build --no-deps api web` with the Docker variables set. Host tests: `bash /c/hx/p8/sync.sh`, then `node scripts/run-tests.mjs` in `C:\hx\p8\api` (on its own: Vitest in parallel times tests out on this host) and `npx vitest run` in `C:\hx\p8\web`.

---

## Audit fixes (code): 7 findings of `audit/AUDIT_REPORT.md` A, D, E, H (2026-10-26)

8 commits, 1 per fix (fix 6 has an image part and a stats part), each holding only its own hunks; fixes 5, 6 and 1 share files and were staged separately. `web/` and the documents were not touched except ADAPTERS R-11 and DATA_MODEL 2.1 (and the one `price_snapshot` line of its section 3).

### Shipped

| # | Commit | What |
|---|---|---|
| 1 | `e73e939` | **The agent's shell can no longer read `/tasks` or `out/`.** With `WORKER_RUN_AS=agent` (set by the image) the trial child runs as the unprivileged user `agent`. The tasks mount moved to `/srv/evals/tasks` (`/srv/evals` is root, mode 700; a bind mount ignores chmod, so the mount point's parent is what closes it) and `out/` is root, mode 700. The child gets a spec with no graders and no judge model; it writes `child/events.jsonl` and `child/result.json` (the one trial directory it owns). The runner, as root, copies the fixture in, collects both files into `out/` (read through a directory fd with `O_NOFOLLOW`; a malformed result is a `worker_crash`), grades (R-7 now happens in the runner, not in the child) and writes `out/result.json`. Before every trial a probe that runs as `agent` must find the tasks directory and `out/` closed, else the trial is a `worker_crash` and no child starts. New file `worker/privilege.py`. Recorded as **R-11** in ADAPTERS section 6, with the supersession of R-7's "same child process". |
| 2 | `08de24d` | `cached_input_price_per_mtok` on `model` (schema, migration `0004_cached_input_price`, seed, DATA_MODEL 2.1 and the `price_snapshot` line), copied into `trial.price_snapshot`; `costUsd` charges `cache_read_tokens` at it on top of input and output (`input_tokens` excludes cached tokens, DESIGN 13.14). A snapshot without the field falls back to the input price (upper bound). Values fetched from OpenRouter's endpoints listing on **2026-10-26**: model-a 0.01 USD per million tokens (all standard endpoints); model-b 0.009 (the registry's 0.018 and 0.09 are the Darkbloom endpoint's prices, and its cache read is 0.000000009 per token). |
| 3 | `5b8912c` | `ingest` refuses a done result whose `grader_results` count differs from the task's grader count; it surfaces as an errored `worker_crash`, which `decideRetry` retries. The task context is now required for every done result (`FailureTask.graderCount`). |
| 4 | `ff483e9` | The ingest fallback evidence names `WRONG_ANSWER_RULE`, looked up in `RULES` by category (12 today), not the literal 10. |
| 5 | `a90dfbc` | `WORKER_REGISTRY` (any module) is gone. The fake adapter registers only when `WORKER_FAKE_ADAPTER=1`; `worker.server` raises at import (so the worker never starts) and `load_registry` raises unless `WORKER_ENV` or `NODE_ENV` is `test`. `worker/.dockerignore` lists `**/__pycache__`, `**/*.pyc` and `tests/`. |
| 6 | `d17a51e`, `509dc66` | `STATS_VERSION` is 1.1.0 (1 bump covers the `failures` and `per_task` fields and fix 7). The image bakes `GIT_COMMIT` as the label `org.opencontainers.image.revision` and as `WORKER_COMMIT`; `GET /adapters` returns it as top-level `commit` (`worker_manifest.commit`) and `worker.image_digest` is null when empty. A container cannot know its own digest at build time, so `scripts/up.sh` builds, reads the image id and exports `IMAGE_DIGEST` and `GIT_COMMIT` before `docker compose up`; run compose by hand and the manifest carries the commit only. |
| 7 | `c34bdbe` | `failures` counts every done-and-failed trial of A and B, any task. Judge tasks withheld by policy `excluded` are counted in the new `failures_judge_excluded` block (same shape; null under `trusted` and `flagged`). The headline, `n_scored` and the rates are unchanged. |

### Verified

| Check | Result |
|---|---|
| Worker suite, container (`docker build ./worker`, then `docker run --rm -v <repo>/worker/tests:/app/worker/tests:ro -v <repo>/tasks:/srv/evals/tasks:ro -v <repo>/docker-compose.yml:/app/docker-compose.yml:ro <image> python -m pytest -q -rfs`; the mounts are needed because the image no longer holds `tests/`) | exit 0, **643 passed, 28 skipped** in 945.76 s, 0 failed. Before: 613 passed, 28 skipped. 30 new tests: fake-adapter gate 10, R-11 runner and helpers 14, R-11 conformance 2 (1 per adapter), image wiring 3, server manifest 1. After that run `test_image_wiring.py` was split into 4 tests and `test_spec_isolation.py` got a docstring edit; both files were rerun: 9 passed, 1 skipped (root can delete from a read-only directory). |
| API suite, container (fresh image, own compose project) | exit 0, **`Test Suites: 1 skipped, 36 passed, 36 of 37 total`; `Tests: 3 skipped, 726 passed, 729 total`**. Before: 703 passed. 23 new tests. `npx tsc --noEmit` exit 0. Migration 0004 applied on a database already at 0003 holding a model row (that row got 0 until the next seed). |
| R-11 mutation 1 (child stays root: the `user=` line of the `Popen` call removed) | `test_r11_an_agent_that_goes_looking_in_the_tasks_and_out_is_denied[minimal_loop]` red: `WHOAMI=root`, and the probe's output lists the task JSON (the `"expected"` text is visible) and `out/`. |
| R-11 mutation 2 (`out/` mode 755 and the access probe removed) | the same test red: `Permission denied` 2 times, 5 or more expected. |
| R-11, both adapters | the conformance test is green for Hermes and the minimal loop as `agent`: `id -un` is `agent`; `ls <tasks>`, `cat <tasks>/<task>.json`, `ls ../out`, `cat ../out/*` and `cat ../out/events.jsonl` all say `Permission denied`; the grader sentinel never appears; the 2 graders were scored by the runner (`[true, false]`); `out/` is root, mode 700 after the run. |
| Real compose bind mount | `docker compose -p auditfixw run` on the compose-built image: `RunnerConfig.from_env()` gives `run_as agent`, `tasks_dir /srv/evals/tasks`; the access probe finds the mount closed to `agent`; `/adapters` returns `commit` (the git sha) and `image_digest sha256:test`; 1 trial of each adapter against the stub on a real task (`det-01-csv-count`) ended `done`. Torn down afterwards. |
| API fixes 2, 3, 4, 6 (stats), 7: red without the fix | each new test fails with the old source mounted over the baked image (fix 2: 3 ingest tests, the seed and `/models` tests; fix 3: 4 tests; fix 4: 1 test; stats version: 1 test; fix 7: 10 tests across `compare.spec.ts` and `compare.endpoints.spec.ts`). The `rules.spec.ts` test for fix 4 was not run red separately. |

### Cut on purpose

- No per-trial uid (1 `agent` for all trials) and no mount namespace: the request asked for an unprivileged user.
- `IMAGE_DIGEST` is not computed inside compose (it cannot be): `scripts/up.sh` does it.
- The worker's `ModelSpec` does not read `cached_input_price_per_mtok` (it ignores unknown keys); only the API prices.
- Old `trial.price_snapshot` rows, the committed exports and the P5 costs were not recomputed.

### Found but not fixed

1. **A stack built before these commits breaks on the compose change, in a safe way.** The `p5run` and default stacks run old images. A new worker image behind an old compose file (tasks still at `/tasks`, `TASKS_DIR=/tasks`) fails closed: the access probe finds `/tasks` readable and every trial is a `worker_crash` saying so. Move both together: rebuild and recreate with the new `docker-compose.yml` (or `scripts/up.sh`); the api then applies migration 0004 and the new seed prices at start. `p5run`'s own compose copy needs the same mount line.
2. **Documents are stale again.** DESIGN 13.6, 13.13 and 11 still say `/tasks` is readable and closing it is the open audit fix; DESIGN 9.6 describes `failures` as headline-only and `stats_version` as 1.0.0; the caveats of the "Audit fixes (docs)" section (`STATS_VERSION`, the fallback rule number, the image digest, `/tasks`) are now resolved; ADAPTERS R-3 and R-4 name `out/result.json` and `out/events.jsonl` as written by the child (the runner writes them now; R-11 says so). Not edited: only R-11 and DATA_MODEL 2.1 were allowed.
3. **Concurrent trials share the `agent` user.** `trials/` is mode 711 and `specs/` is 1733, so a shell cannot list the other trials, but a trial id seen in `/proc/<pid>/cmdline` leads to another trial's workspace and `child/`. A per-trial uid fixes it.
4. **The graders run agent-written code as root.** `unit_test` runs the workspace's tests in the runner; hidden test files are copied into the workspace, and a symlinked directory the agent planted inside it would send that copy elsewhere as root. Only a swap of the top-level `workspace/` for a link is handled (it is replaced by an empty directory, so the graders fail); that branch has no test.
5. **Grading is no longer bounded by the child timeout.** `llm_judge` and `unit_test` run in the runner after the child; they have their own timeouts, but the 60 s kill margin does not cover them any more.
6. **After a timeout kill, `collect_memory` runs as root over a directory the agent owned** and follows links; the result goes only into that trial's `memory_final`.
7. **The spec file (R-10) is still written, and chowned to `agent`.** It holds no grader any more; the spec with the graders is never on disk. The request said to make the spec root-only, which cannot hold while the child must read its own spec.
8. **`web/` does not know `failures_judge_excluded`** and shows broader `failures` counts than before (`web/src/api/types.ts`, `CompareView.vue`).
9. **P5 numbers are unchanged.** Cost in the committed results is still a floor; `experiments/p5/analyze.mjs` still computes its own ceiling from `cache_read_tokens`.
10. **The secondary experiment (`01M5STXWYMRDGQFJ47DNK5Y83S`) stays unreliable for model-a**; the primary one is unaffected (0 reads of `spec.json` in its 132 trials). These fixes close the paths for future runs, they do not repair that run.

### Assumptions resolved

- No A-id. Readings taken: "the spec unreadable" as "the spec holds no grader and the grader-bearing one is never written"; "grading as root in the parent" as moving `run_graders` out of `run_one.py`; "worker_manifest.commit" as a top-level `commit` key of the `/adapters` response (the API stores that response unchanged); cache-read tokens as additive to `input_tokens` (DESIGN 13.14).

### Next action

1. Rebuild the stacks you still use with `scripts/up.sh -d` (set `DOCKER_BUILDKIT=0 COMPOSE_BAKE=false` on this host) and change `p5run`'s compose mount to `/srv/evals/tasks`.
2. Update DESIGN 13.6, 13.13, 9.6 and ADAPTERS R-3, R-4 (point 2 above) and the web types (point 8).
3. If the secondary experiment is to be quoted for model-a, re-run it on the rebuilt stack (STATE P5 follow-up, Next action).

---

## Audit fixes (docs): documents now describe the code as built (2026-10-26)

Source: `audit/AUDIT_REPORT.md` B.2, B.3, B.5 and H row 10. Documents only; the one code-file edit is a docstring. No test was affected and none was run.

### Shipped

- **DESIGN.md.** 9.4 (`MIN_PAIRED_TASKS = 2`, `MIN_TRIALS_PER_SIDE = 2`, verdict `insufficient_data`); 9.6 (the payload as `compare.ts` returns it, with the fields the first draft lacked listed in a "changed in build" note, and the fact that `stats_version` stayed `1.0.0` while it grew); 9.7 (the pilot tries every integer from `n_pilot` to 8; capped, not-ready and above-cap cases); 13.6 (`spec.json` is no longer readable, R-10; what an agent can still reach: `/tasks`, `_hidden/`, `../memory/` for the minimal loop, `../hermes_home/` for Hermes; "the one path an agent had a reason to try is closed", not "the graders are unreadable"); 13.13 (a note that the described run predates the fix); 11.19 (new entry: `content_after` is read in the `post_tool_call` hook at write time, not by `collect_memory()`); the 11 preamble (ADAPTERS.md was edited after the audit); 10.6 (new draft: the committed exports predate P6 and the isolation fix, and cannot be reproduced from this tree alone).
- **ADAPTERS.md.** Section 0 (`api/src/worker-client/`, not `api/src/adapters/`); section 2 (`POST` validate, in the docstring and in a note); section 3 (`content_after` row points to DESIGN 11.19); section 6 (new row R-10, with the tests that pin it).
- **`worker/adapters/base.py`.** The `validate()` docstring says `POST`. Comment text only; `py_compile` passes.
- **Cards.** A "Superseded by the build in these points" block at the top of `cards/P1.md` (§10 question 5, Node 24), `cards/P2.md` (§4 `task-schema.ts` not `schema.json`; §6 `_hidden/`, `lint-cli.ts`, judge files under `api/src/judge/`, 413 lines not 150) and `cards/P6.md` (§4: 12 rules, `wrong_tool_usage`, rule 5 reads the output).
- **README.md.** The judge sentence now says "validation protocol is in DESIGN 8" and that the 30 labels are not made. To flip it after the labels and `npm run judge:kappa`, replace that clause with "the judge is validated against 30 human labels, kappa reported in DESIGN 10.4" and fill 10.4 first.

### Verified

| Check | Result |
|---|---|
| Each changed statement against the code | read against `compare.ts` (payload type, `MIN_PAIRED_TASKS`, `MIN_TRIALS_PER_SIDE`, `pairedBlock`), `pilot.ts` (the loop from `nPilot` to `N_CAP`, `capped`, `recommendationReason`), `runner.py` (`_spec_path`), `run_one.py` (`consume_spec`, `assert_trial_dir_holds_no_extras`), `hermes/adapter.py` (`post_tool_call`), `rules.ts` (`FAILURE_CATEGORIES`, `rule:` numbers 1 to 12), `api/src/worker-client/`, `api/src/tasks/`, `api/src/judge/`, `tasks/fixtures/*/_hidden` |
| Test names cited in R-10 | `grep "def test_r10"` finds them in `test_spec_isolation.py` (6) and `test_adapter_conformance.py` (1) |
| `py_compile worker/adapters/base.py` | passes |
| Stale text left | `grep "GET /adapters/{id}/validate"` hits only DESIGN 11.1, which quotes the old text on purpose; `../spec.json` appears only in the historical checks of 10.4 and 10.5 and in R-10 |
| Em-dashes in added lines | 0 (`git diff -U0`) |
| Worker, API and web suites | not run (no code changed) |

### Cut on purpose

- Nothing in code. Not touched although the audit lists them: R39 (the worker manifest never records an image digest; compose does not set `IMAGE_DIGEST`), the `STATS_VERSION` bump for the payload that grew (audit section D, row 1), the fallback rule number in `ingest.ts` (audit section D, row 3), closing `/tasks`.
- `DESIGN.md` 10.4 and 12.2 were not changed; the numbers there are not in dispute.

### Found but not fixed

1. **13.6 describes a gap that is still open.** `/tasks` is readable by the agent's shell. The text says so and says what is closed; the audit code fix (confinement) has to land before it can say more.
2. **The README judge sentence is a placeholder** until `labels.jsonl` exists. If the labels are never made, the sentence stays as it is; it is true as written.
3. **`cards/P6.md` §1 still says `judge_label` rows exist for 30 trials.** They do not (0 rows, no `labels.jsonl`). It was outside the points the audit asked to be fixed, so it is not in the P6 note.
4. **ADAPTERS.md header says "FROZEN" and silent edits are a defect.** The edits carry "changed in build" notes or are a new row, and DESIGN 11 says so; the header was not reworded.
5. **STATE.md older sections still say the documents are stale** (P5 follow-up: Isolation fix, Found 3). This section supersedes them; they were not rewritten.
6. The new section sits first after section 0, because this file is written newest first, not at the end.

### Assumptions resolved

- No A-id. Reading choice: "full payload shape as compare.ts returns it" was taken as the `ComparePayload` type in `compare.ts`, with `AggregateBlock`, `CategoryBlock`, `PerTaskRow`, `FailureHistogram`, `MetricComparison` and the two test result types spelled out in the example.

### Next action

1. Nothing pending for this task.
2. The code fixes of the audit (confinement of `/tasks`, `STATS_VERSION`, image digest, `ingest.ts` fallback rule number, the 17 column export regenerated) are separate; when each lands, drop its caveat from 13.6, 9.6 and 10.6.
3. After the 30 labels: run `npm run judge:kappa`, fill 10.4, then change the README judge sentence as described under Shipped.

---

## P7: UI visual layer (polish only, no logic)

Built on the same Windows 11 host in the OneDrive checkout; Vitest, `vue-tsc` and `vite build` ran on a mirror of `web/` at `C:\hx\p7\web` (robocopy, `node_modules` a junction to `C:\hx\p6\wt\web\node_modules`, same `package-lock.json`). Before any code the 4 design skills of card section 2 were loaded in order (impeccable, ui-ux-pro-max, high-end-visual-design, design-taste-frontend); where they disagreed with the card, the card won (Found 4). Only `web/` and this section were changed.

### Shipped

- **S1 the system.** `web/src/styles/tokens.css`: every colour, size, space, radius and duration as a CSS variable, dark under `:root` and `[data-theme='dark']`, light under `[data-theme='light']`, the card's palette. Names: `--bg`, `--surface-1`, `--surface-2`, `--border`, `--border-strong`, `--text`, `--text-muted`, `--accent`, `--accent-hover`, `--accent-text`, `--accent-gradient`, `--pass`, `--fail`, `--noise`, `--info` with their `-text` and `-tint` forms, `--font-ui`, `--font-mono`, `--fs-12` to `--fs-28`, `--fw-regular` and `--fw-strong`, `--space-1` to `--space-6`, `--radius-card` 10 px, `--radius-control` 6 px, `--radius-pill`, `--ease-out`, `--dur-fast` 150 ms, `--dur-theme` 250 ms, `--content-max` 1,440 px, `--header-h` 56 px. `styles/base.css`: reset, type, tables (tabular numerals, numbers right-aligned and mono, row hover), controls, chips and badges (semantic colours only), notices (full border and tint, no side stripes), verdict pills, hero numerals, definition lists, code blocks, the skeleton shimmer, the native `<progress>` restyled, a `prefers-reduced-motion` block. `src/styles.css` is now 2 `@import`s, so `main.ts` was not touched. `lib/theme.ts`: `useTheme()` reads the stored choice in `localStorage["evals.theme"]`, else the system preference, else dark; sets `data-theme` on `<html>`; a 250 ms colour transition only while switching, skipped under reduced motion. `index.html`: the same rule inline before the app loads (first paint in the right theme), Inter and JetBrains Mono from Google Fonts with `display=swap` (weights 400 and 600), title "Agent Evals", an inline SVG favicon. Components: `ThemeToggle.vue` (2 labelled options, `aria-pressed`), `AppShell.vue` (56 px sticky bar, "Agent Evals" wordmark in the accent, Configs and Experiments with an active underline, the API base field that was in `App.vue`, the toggle, the gradient underline), `Skeleton.vue`, `EmptyState.vue`, `DataTable.vue` (scroll box with a sticky header; attributes land on the `<table>`, so `table.trials` and the test ids hold; a `#caption` slot; whole-row links through `data-href` that leave links and inputs inside the row alone), `CountUp.vue` (0 to the value over 400 ms on first render, ease-out, then exactly `num(value)`; no animation under reduced motion or without `matchMedia`).
- **S2** `ConfigsView`, `ExperimentsView`: title row with subtitle, tables through `DataTable` (experiment rows clickable in full), skeleton while loading, empty states that say the next step ("No experiments yet. Create one from 2 configs with the form below."), forms in a surface card, checked configs outlined.
- **S3** `ExperimentDetailView`: title with chips and the axis, the hypothesis card next to the run facts and progress, 1 toolbar with the actions and compare/export, the trials table in a 640 px scroll box with a sticky header and rows that open the trial, the pilot panel with its table.
- **S4** `CompareView`: the caveats first (badges at 13 px, the judge-excluded and unpaired notices, the counts line), then the axis, then the aggregate card: the A and B pass rates as 28 px numerals that count up, the delta as a 28 px numeral with `[lo, hi]` beneath in muted mono and an inline CI bar, the verdict sentence in a 28 px tinted pill. Category cards with CI bars; per-task tables with an inline CI bar in every delta cell and the "direction only" caption inside the table box; the failure table; the metrics table; the 3 SVGs restyled with tokens (no new chart).
- **S5** `TrialView`: PASS/FAIL as a 28 px tinted pill beside the trial id, exit reason and steps; the facts in a card; "Why it failed" as a fail-bordered panel with the category, rule, evidence buttons and each failing grader; grader cards; prompt and final response side by side; the timeline in a panel with pill filters. `TraceEvent`: mono content, an icon next to every kind label, a gutter line from a `tool_call` down into its `tool_result` (plus "to #n" and "from #n"), memory rows tinted info, skill rows tinted pass, error rows tinted fail. `GraderDetail`: restyled, PASS/FAIL as a small tinted pill.
- `Interval.vue` gained 2 optional props, `hero` and `bar`; its text is still exactly `x [lo, hi]`. `StatusChip.vue`: comment only.
- Tests: `components/__tests__/visual-layer.spec.ts`, 8 new (theme attribute, storage and pressed state; DataTable attributes and row navigation; CountUp final text; the bar keeps the interval text and draws no span without bounds). No existing test was changed.
- 8 screenshots in `web/docs/walk-p7/` (`dark-` and `light-` times `1-experiment`, `2-compare`, `3-trial-failed-mem05-off`, `4-trial-passed-mem05-seeded`, at 1,440 px) and `walk-report.txt`.

### Verified

| Gate | Result |
|---|---|
| 1 Harness | `vitest run`: **242 of 242** passed, 12 files: the 234 that existed, all unchanged and green, plus the 8 new. Baseline before any change: 234 of 234. |
| 1 Mutation test | The reliability badge (the 3-line `<span ... data-testid="badge-reliability">`) was removed from `CompareView.vue` in the mirror: `CompareView.spec.ts` **3 failed, 60 passed** (63): "puts the reliability, judge policy and rate-limit badges before the aggregate card", "shows a neutral rate-limit badge with the count 0 and good badges for complete and trusted", "shows partial reliability with the unfinished and excluded counts". Restored from a copy: sha256 `fa89a088681f7e96e06e533f7b6b489ca9fa0adb36000e2907842e3b1f1320ca` before and after, equal to the OneDrive file; 63 of 63 again. |
| 2 Audit | `web/` copied into `C:\hx\p5src\web`, `docker compose -p p5run -f C:/hx/p5src/docker-compose.yml build web` (classic builder): the build stage printed `Test Files 12 passed (12)`, `Tests 242 passed (242)`, then `vite build`; exit 0. |
| 3 Typecheck and build | `vue-tsc --noEmit` exit 0, no output; `vite build` exit 0 (CSS 36.62 kB, JS 210.49 kB, 71.93 kB gzip). 0 em-dashes and 0 en-dashes in `web/` (every `.vue`, `.ts`, `.css`, `.html`, `.conf` file and the Dockerfile); no `v-html`, `alert` or `confirm`. |
| 4 and 5 The walk | `p5run-web-1` recreated on the new image (`up -d --no-deps web`; api, db and worker untouched), driven by a headless Chrome through `playwright-core` (`C:\hx\p7\walk\walk.mjs`) at `http://localhost:8280`: the primary experiment `01M5SRTYPNZ9EWV1HX8KJGX40N`, its Compare (A off, B seeded), the failed `mem-05-lint` trial under memory off `01M5SRTYYFKEFMG9GHK40QFHQQ` (`wrong_tool_usage`, evidence grader #1) and the passed one under seeded `01M5SRTYYFKEFMG9GHK40QFHQR`, each in dark and light at 1,440 and 1,024 px: 16 of 16 pages with 0 px horizontal page overflow, the right `data-theme` and body background, Inter loaded, 0 console errors. Toggle: nothing stored and a dark system gave `dark`; clicking Light gave `light` and stored `light`; after a reload still `light` with Light pressed; Dark and reload gave `dark`; a light system with nothing stored gave `light`. Report: `web/docs/walk-p7/walk-report.txt`. The numbers on the Compare page are the P5 headline: A 0.667, B 0.980, delta -0.314 [-0.549, -0.098], "B better by 0.314 [0.098, 0.549]", min detectable 0.225. |

Contrast (card 10.3, the WCAG 2 formula; the script is `contrast.mjs` in this session's scratchpad). Dark, against bg / surface 1 / surface 2: text 15.89 / 14.72 / 13.28, muted 6.64 / 6.15 / 5.55, accent 8.19 / 7.58 / 6.84, pass 9.02 / 8.36 / 7.54, fail 6.24 / 5.78 / 5.21, noise 10.61 / 9.83 / 8.87; each semantic colour on its own 12 percent tint at least 5.01. Light: text 17.60 / 18.72 / 16.65, muted 5.08 / 5.40 / 4.81. The card's hues as text on white are under AA (pass, noise and the accent about 2.0 to 2.3, fail 3.0), so light-theme text in them uses darker shades of the same hues: accent and info `#086a97` 5.61 / 5.97 / 5.31, pass `#0d7048` 5.76 / 6.13 / 5.45, fail `#c8283a` 5.17 / 5.50 / 4.89, noise `#8a5a00` 5.57 / 5.93 / 5.27; on their own tints at least 4.81. The primary button carries dark text (`#0b1220`) on the gradient: 4.3 at the blue end, 5.9 in the middle, 8.19 at the cyan end (white text would be 2.29 to 4.51).

### Cut on purpose

Everything in the card's out-of-scope list: no new chart (the failure table has no bars; the CI bars are the card's), no animation, component or icon library, nothing below 1,024 px. Nothing moves except hover and expand (150 ms), the theme switch (250 ms), the skeleton shimmer and the 400 ms count-up; no route transitions, no toasts; the running chip has a static dot, not a pulse.

### Found but not fixed

1. **Where the card and its section 9 meet.** The count-up is a component (`CountUp.vue`), not a composable in a `.ts` file, because section 9 allows only `theme.ts` and components; `src/styles.css` became the 2 imports instead of an edit to `main.ts`. `index.html` changed (fonts, the pre-paint theme script, title, favicon).
2. **Light-theme text is not in the card's exact hues** for accent and semantic text (table above); the hues stay for fills, bars, marks and tints. Card 10.3 (AA) was read as overriding "same accent" for text only.
3. **Wide tables at 1,024 px scroll inside their box** (the trials table and the per-task tables lose the last 1 or 2 columns to the scroll); the page never scrolls sideways. The card asks only that nothing breaks at 1,024.
4. **Skill conflicts, the card won:** high-end-visual-design and design-taste-frontend ban Inter and plain 1 px borders and push double-bezel cards, large padding and scroll reveals; ui-ux-pro-max proposed Fira Code and Fira Sans; design-taste-frontend says it is not for dashboards. impeccable asked for a `PRODUCT.md` (outside `web/`, not written) and reported an update of itself (not run). The few icons (trace kinds, theme toggle, empty state) are hand-drawn 16 px geometric SVGs, which design-taste-frontend discourages; the card rules out new libraries.
5. **Blind labelling (P5 Next action 1):** `web/docs/walk-p7/dark-2-compare.png` and `light-2-compare.png` show the per-task rates of the 5 judged tasks (the "Excluded by the judge policy" table). The labeler should not open those 2 files before `labels.jsonl` is committed.
6. **The `p5run` web container now serves the P7 UI**, built from a copy of the working tree, not from `git archive`; the copy of `web/` that was in `C:\hx\p5src\web` before is at `C:\hx\p7\p5src-web-before`. `web/docs/` was copied along (it is in `.dockerignore`).
7. Fonts come from Google Fonts; offline the system fallback is used (card 10.1). The walk had network.
8. Not done: ESLint, Prettier, a screen-reader pass. The walk was a scripted headless Chrome, not a hand click-through (the `playwright` MCP server timed out at session start, as in P4).

### Assumptions resolved

- **Card 10.1** (fonts offline): default used. **10.2** (charts): the 3 SVGs restyled with tokens and kept. **10.3** (contrast): checked, AA in both themes with the light text shades above.
- Verdict colours: noise in the noise colour; a decided "A better" or "B better" in the info colour (a difference, not a pass); payload inconsistent as a fail notice; insufficient data muted. Status chips: running, queued, pending info; completed, done pass; partial, paused noise; errored fail; draft, cancelled neutral.

### Next action

P7 is done. To rebuild the `p5run` web container after a later change: copy `web/` into `C:\hx\p5src\web` (or `git archive HEAD web | tar -x -C /c/hx/p5src`), then `docker compose -p p5run -f C:/hx/p5src/docker-compose.yml up -d --build --no-deps web` with the Docker variables set. Host tests: `bash /c/hx/p7/sync.sh`, then `npx vitest run` in `C:\hx\p7\web`. The P5 labels are still open.

---

## P6: Failure categories (stretch)

The first pass hit the stop condition of card section 9 (71.1 percent `wrong_answer`); the architect's 3 decisions were applied afterwards and are in "Follow-up" below. Where the first-pass text and the follow-up disagree, the follow-up wins.

Built in a git worktree (`C:\hx\p6\wt`, branch `p6-failures`, outside OneDrive) so that the P5 session's builds from the shared checkout never saw half-written files, then landed on `main` as one commit. Gates 2 to 5 ran on an isolated compose project `p6verify` (ports 3600, 8600, 8680, own `dbdata`), built from the worktree, with the worker image of the main stack. The P5 stack (`p5run`) was only read: its database was dumped with `pg_dump` (twice) and the dumps were restored into `p6verify`. In the copies, pending and running trials and running experiments were set to `cancelled` so that the copy would not spend money re-running them.

### Shipped

- **S1** `api/src/failures/rules.ts`: `categorize(trial, trace, graderResults, labels) -> {category, evidence}`. `RULES` is an ordered list of 10 entries, first match wins, rule 10 always matches. Evidence is `{rule, category, detail, event_seq?, related_event_seq?, grader_index?, assertion_index?}`. Migration `0003_failure_category` (enum `failure_category`, `trial.failure_category`, `trial.failure_evidence`, CHECK `trial_failure_category_iff_failed` = category set iff `status = 'done' AND passed IS FALSE`, CHECK `trial_failure_evidence_iff_category`). DATA_MODEL 2.7, 3, 4 (D-17) and 5 edited. DESIGN.md 9.6 was not edited (see Found 9).
- **S2** `ingest()` takes a `FailureTask` (task category, fixture, memory mode) and sets `IngestedTrial.failure` for a done, failed result (and refuses such a result without it); `buildSpecAndContext` in `dispatch.ts` supplies it; `settleInTx` writes category and evidence in the same UPDATE as `passed`. `npm run failures:backfill` (`backfill.ts`, `backfill-cli.ts`): recomputes every done, failed trial (not only the empty ones, so a judge label imported later is applied by running it again), writes only what changed, prints a histogram per experiment and config, `--sample N` draws N trials per category (seeded), `--experiment`, `--dry-run`, prints the section 9 stop-condition line, and validates the CHECK when no failed trial lacks a category.
- **S3** Compare payload: `failures: {a, b, uncategorized}` (every category present, rule order) and `per_task[].failure_category_a/_b` (mode, a tie goes to the earlier rule); `export.csv` column `failure_category` (last); `export.json` trials and `GET /trials/:id` and the trial list carry `failure_category` and `failure_evidence`. Web: a "Failure categories" table in `CompareView` and 2 columns in both per-task tables; `TrialView` shows the category, its rule and sentence at the top of "Why it failed" with buttons to the event or grader the rule used (the link re-enables a hidden kind, pages the 200-row window, expands, outlines and scrolls to the event by its `seq`); `TraceEvent` rows got an `id` and a `focused` outline.

### Verified

| Gate | Result |
|---|---|
| 1 Harness (host, final code) | API `node scripts/run-tests.mjs` with `E2E_PYTHON` (real-Hermes stub walk included): `Test Suites: 37 passed, 37 total`, `Tests: 691 passed, 691 total`, 691 of 691. New: `rules.spec.ts` 42 (every rule has a positive and a negative synthetic trace; the card asks for 20), `backfill.spec.ts` 9 (a database built from migrations 0001 and 0002, legacy rows with no category, then 0003, then the backfill), plus new cases in `invariants.spec.ts`, `ingest.spec.ts`, `settle.spec.ts`, `compare.spec.ts`, `compare.endpoints.spec.ts`, `export.e2e.spec.ts`. Web: `vitest run` 234 of 234 (218 old + 16 new, 11 files). |
| 1 Mutation test | In `rules.ts` the entries of rule 1 (`step_exhaustion`) and rule 10 (`wrong_answer`) were swapped in `RULES`. `rules.spec.ts`: **18 failed, 24 passed** (42), including `rule 1: step_exhaustion > matches exit_reason max_steps` and `... comes before every later rule`. Restored from a copy: sha256 `539e8b7accce99d05761d55c9daaaeaa5017ee7672ffac4a8cbcb6479a2e838f` before and after; 42 of 42 again. |
| 2 Audit (containers, `p6verify`) | `docker compose exec api npm test`: exit 0, `Test Suites: 1 skipped, 36 passed`, `Tests: 3 skipped, 688 passed, 691 total` (the 3 skipped are the stub walk, no Python in the api image), 688 of 688 that can run. `docker compose exec worker pytest -q`: exit 0, `606 passed, 27 skipped` (the worker was not changed; same as P3). The web image build ran `npm test` (234 of 234) and `npm run build`. |
| 3 Typecheck and build | `npx tsc --noEmit` exit 0; `npm run build` (prisma generate and nest build) exit 0; `vue-tsc --noEmit` exit 0; `tasks:lint` 22 tasks OK; `docker compose build api web` (classic builder) exit 0. No em-dash in any file of the commit, no `v-html`, `alert` or `confirm` in `web/src`. |
| 4 The walk | The P5 database as dumped at 2026-10-25 20:42 (132 trials, 26 failed) was restored, the api container started on it and applied `0003` (CHECK left `NOT VALID`, 26 failed trials without category), `docker compose exec api npm run failures:backfill -- --sample 5` filled 26 and validated the CHECK; the Compare page (`http://127.0.0.1:8680/experiments/01M5SRTYPNZ9EWV1HX8KJGX40N/compare`, driven with the Playwright MCP browser) showed the table, `web/docs/walk-p6/c2-compare-failures.png`. Trial pages: `tool_error_unrecovered` trial `01M5SRTYYG1J2AHXZX6RS871D5`, evidence button "event #37": exactly 1 row had `data-focused`, `seq` 37, kind `tool_result`, expanded, in the viewport (`d2-trial-tool-error-evidence.png`); `wrong_tool_usage` trial `01M5SRTYYFKEFMG9GHK40QFHQQ`, evidence "grader #1": scrolled to the `trace_check` card. `step_exhaustion`, `no_final_answer` and `wrong_answer` trials were opened and carry rule and sentence; their evidence is a grader or nothing, not an event. No real trial of `timeout`, `hallucinated_tool_args`, `gave_up_early`, `grader_disagreement` or `memory_ignored` exists (Found 5), so their links are covered by the Vitest cases only. |
| 4 Final backfill | A second dump at 2026-10-25 21:09 (264 trials, both P5 experiments: the finished primary one and the secondary one, 45 failed trials) was restored into a database `evals_final`, migrated and backfilled (`web/docs/walk-p6/backfill-histogram-p5-snapshot.txt`). Histogram below. 0 failed trials without a category afterwards. |
| 5 Live | `POST /trials/adhoc` against the `p6verify` stack with the real worker and key (2 trials, about 0.0005 USD): `mem-02-owner` memory off `01M5SVAGQTTSM1PV4PPCXX7038` came back `passed false`, `failure_category no_final_answer` with evidence rule 6, grader 0; `mem-01-staging-db` memory off `01M5SVBWSQ4162CW91WCF3HTAV` came back `step_exhaustion`, rule 1. So the category is stored by the real scheduler path. |

**Histogram (card section 8 gate 4), `failures:backfill` on the 21:09 dump, all 45 failed trials of both P5 experiments:**

| experiment, config | failed | step_exhaustion | wrong_tool_usage | tool_error_unrecovered | no_final_answer | wrong_answer | other 5 |
|---|---|---|---|---|---|---|---|
| primary, memory off | 29 | 5 | 3 | 1 | 3 | 17 | 0 |
| primary, memory seeded | 7 | 0 | 0 | 0 | 0 | 7 | 0 |
| secondary, memory off (`model-b`) | 4 | 1 | 0 | 0 | 0 | 3 | 0 |
| secondary, memory off (`claude-haiku-5.5`) | 5 | 0 | 0 | 0 | 0 | 5 | 0 |
| all | 45 | 6 | 3 | 1 | 3 | **32 (71.1 percent)** | 0 |

The primary experiment alone: 36 failed, 24 `wrong_answer` (66.7 percent). The secondary experiment was still running at the dump, so its rows are partial. The 5 "other" categories are `timeout`, `hallucinated_tool_args`, `gave_up_early`, `grader_disagreement` and `memory_ignored`: 0 in the real data.

### Cut on purpose

Everything in the card's out-of-scope list (no model-based categories, 1 label per trial, no manual editing, no re-runs). Also: no new rules or categories after the stop condition (Found 1); no column for the category in the experiment's trial table; no category on `compare.csv`.

### Found but not fixed

1. **Stop condition of section 9 reached: 71.1 percent of the failures (32 of 45) are `wrong_answer`; the primary experiment alone 66.7 percent (24 of 36).** No rule was added or changed after seeing this; an architect decision is needed. What is in the bucket (the 32): 22 are `llm_judge`-graded deliverables whose rubric was not met (`jdg-02-commit` 8, `jdg-03-docstring` 6, `mem-06-release` 4, `jdg-01-summary` 3, `jdg-04-flaky` 1); 10 are not: `mem-02-owner` 4 and `mem-03-config` 4 (memory off, the agent said it did not know or asked the user for the content, 1 step to 14 steps), `det-05-rename` 1 and `mem-01-staging-db` 1. Rule 8 can only name a judge failure when a human label says it passed, and no `labels.jsonl` exists yet, so every judge failure lands here. Two candidates for the architect, both pure rules: a category for "judge criteria unmet" (the criteria array is in `grader_result.details`) and one for "abstained or asked instead of acting" (no tool call after the question, no FINAL line, or `FINAL: Unknown`). Note that the Compare page counts only the tasks of the headline comparison and the judged tasks are withheld while the judge policy is `excluded`, so its own `wrong_answer` row is smaller than the backfill's (in the first dump 5 of 13 failures on the page against 18 of 26 in the backfill).
2. **Rule 5 misfires on a benign tool exit.** Hermes marks a `grep` that found nothing (`exit_code 1`, `exit_code_meaning: "No matches found (not an error)"`) as `is_error`, so trial `01M5SRTYYG1J2AHXZX6RS871D5` is `tool_error_unrecovered` although the real cause is that the agent gave up and asked the user a question (it was in the `wrong_answer`/abstained family of Found 1). It is the only `tool_error_unrecovered` in the data. The same flag could make rule 3 fire on a repeated no-match search only if the output also matches an argument-error pattern, which a benign no-match does not.
3. **`wrong_tool_usage` is a misleading name for what it caught.** All 3 are `mem-05-lint` runs that executed `python lint.py` without `--strict`: the tool was right, the flag was missing. The rule is as written in the card (a failed `tool_called` assertion).
4. **A Hermes "No reply" notice is not "empty" for non-`exact_match` tasks.** Hermes puts a text such as "⚠️ No reply: ... didn't produce a reply" or "The model's reply was cut off ..." in `final_response`. On `exact_match` tasks it has no FINAL line, so rule 6 takes it (3 trials); on a `file_state` task (`det-07-sort`, in the main stack's older data) the card's rule 6 does not, and it falls to `wrong_answer`. I first wrote the notice into rule 6 as "empty" and took it out again when the stop condition was reached; it is a one-line candidate for the architect (a regex on the start of `final_response`).
5. **5 categories have no real instance** (0 in 45): `timeout`, `hallucinated_tool_args`, `gave_up_early`, `grader_disagreement`, `memory_ignored`. `memory_ignored` needs a seeded exact_match failure and none occurred (the 7 seeded failures are judged tasks and `det-05`). `grader_disagreement` needs `labels.jsonl`; after `judge:kappa` imports labels, run `failures:backfill` again. These rules are tested on synthetic traces only; the card's sanity read of "5 random trials per category" was done on what exists (the `--sample 5` output is in the histogram file).
6. **The real P5 database was not backfilled.** `p5run` runs the P4 images; once `0003` is applied there, its old API would fail every settle of a failed trial on the new CHECK (it writes `passed = false` without a category), so applying the migration under a running experiment would have broken the run. The backfill was run on dumps of it. To do it for real after the experiments have finished: `git pull` the commit, `docker compose -p p5run up -d --build api` (the container applies `0003` at start, the CHECK stays `NOT VALID`), then `docker compose -p p5run exec api npm run failures:backfill -- --sample 5`. The numbers will match the table above for the trials that existed at the dump (the rules are pure).
7. **An experiment running during the upgrade** keeps trials it started with the old API unsettled for `timeout_seconds + 180` s after the restart (P3 Found 4), so restart `api` when nothing is running.
8. **Hermes marks a non-zero exit as `is_error`** in general (Found 2); rule 5 and rule 3 trust that flag as the card says.
9. **Not done:** DESIGN.md 9.6 was not edited (the payload gained `failures` and `per_task[].failure_category_a/_b`; `STATS_VERSION` stays `1.0.0` because no statistic changed; `comparison_run` rows written before this have no `failures`). ESLint and Prettier were not run. `.playwright-mcp/` (the browser tool's output folder) is left untracked in the checkout. The worktree `C:\hx\p6\wt` and the `p6verify` volumes are left in place.

### Assumptions resolved

- **Card 10.1** (rule 3 patterns): the 4 listed, case-insensitive (`No such file`, `not found`, `invalid argument`, a JSON parse failure), plus `Traceback` in a `shell` result. The JSON parse failure is these patterns: `JSONDecodeError`, `invalid json`, `malformed json`, `json parse|decode ... error|failure|failed`, `failed to parse (the) (tool) (call) arguments|json`, `expecting value|property name enclosed in double quotes`, `unexpected token`. The minimal loop's `error: FileNotFoundError: No such file ...` and `error: JSONDecodeError ...` are what they were written against.
- **Card 10.2** (`memory_ignored` also needs the fact in the seed): used, literally `memory_initial["MEMORY.md"]`, compared case-insensitively with whitespace collapsed; the expected strings come from the failed `exact_match` graders' `details.expected`. A memory task graded by `file_state`, `trace_check` or `llm_judge` has no expected string and cannot be `memory_ignored`.
- **Readings of the card text:** rule 3's "next assistant message" is the first `tool_call` or assistant message after the failed result that belongs to a later `step`, and a repeat is any `tool_call` of that step with the same `tool` and the same args (compared as canonical JSON, so key order does not matter); a final answer in that step means no repeat. Rule 5's "last tool_result before the final answer" is the last `tool_result` event of the trace. Rule 6: an empty or whitespace `final_response` for any task, or no FINAL line (the exact_match grader's own regex) when an `exact_match` grader failed. Rule 7 needs `steps` not null, at most 2, no `tool_call` event, and a non-null fixture directory. Rule 8 fires when any label with `human_passed = true` exists on a failed `llm_judge` grader of the trial. The histogram on the Compare page counts the failed trials of the tasks in the headline (the same ones as `n_scored`).
- **Ingest cannot apply rule 8** (a label needs a stored grader result); the backfill does.

### Follow-up: the architect's 3 decisions, applied (2026-10-26)

Decided after the stop condition of Found 1 (the rest of this section is the record as of the first pass; `wrong_tool` in it is now `wrong_tool_usage`, and the counts and the "10 rules" are superseded by this follow-up).

- **Decision 1, 2 new pure rules.** The table is now 12 rules in this order: 1 `step_exhaustion`, 2 `timeout`, 3 `hallucinated_tool_args`, 4 `wrong_tool_usage`, 5 `tool_error_unrecovered`, 6 `no_final_answer`, 7 `gave_up_early`, **8 `judge_criteria_unmet`**, 9 `grader_disagreement`, 10 `memory_ignored`, **11 `abstained`**, 12 `wrong_answer`. `judge_criteria_unmet`: a failed `llm_judge` grader and no `judge_label` of the trial with `human_passed = true` (so it is the rule just before `grader_disagreement`, which takes the trials a label calls passed); the evidence names the unmet criteria from `details.criteria` ("criteria c2, c3 not met"). `abstained`: the final response matches one of `ABSTAIN_PATTERNS` (does not know, cannot find or determine, is not documented, `FINAL: unknown`, or asks the user: "could you provide ...", "which ... are you referring to", a reply that ends with a question mark; typographic apostrophes are straightened first) and no `tool_call` event follows the last assistant message; the evidence is that message's `seq`. It sits after `memory_ignored` (a seeded task that said "I don't know" is better explained by the ignored memory) and immediately before `wrong_answer`. Read as written: "no judge_label marks the trial human_passed" is any label of the trial, not only one on the failed grader.
- **Decision 2, `wrong_tool` is `wrong_tool_usage`** in the enum, schema, migration, rules, DATA_MODEL, and the web types, rule sentence and fixtures. Migration `0003_failure_category` was edited in place (the 2 new values, the new name): it had been applied to no real database before this follow-up (only to the throwaway `p6verify` copies, since removed).
- **Decision 3, rule 5 reads the output.** `tool_error_unrecovered` needs the last `tool_result` to have `is_error` true AND an output that matches `TOOL_ERROR_PATTERNS` (a non-empty `"error": "..."` field, a leading `error`, a Python traceback, `command not found`, `no such file or directory`, `cannot access`, `permission denied`, `not found`, `unknown tool`, `timed out`, `exception`), after `"error": null` and `(not an error)` are removed from the text. A `grep` with no matches, and a lint run that exits 1 with findings, are therefore not errors. Calibrated on the 86 `is_error` tool results of the P5 database (all kinds listed in `rules.spec.ts`).
- **The web was touched beyond the rename only as far as the enum needed it:** 2 more values in the `FailureCategory` type and in the category list the table iterates, 2 rule sentences and the changed sentence of rule 5 in `web/src/lib/failures.ts`, and the 2 keys in the test fixtures. No view, layout or behaviour changed.

**Verified (follow-up).** Host API `node scripts/run-tests.mjs` with `E2E_PYTHON`: 37 suites, 706 of 706 passed (the first run of this code had 1 failing test, a hard-coded count of 10 categories in `compare.endpoints.spec.ts`, fixed and the file rerun 30 of 30). `rules.spec.ts` is 57 tests (new: rule 5 on benign and real error outputs, `judge_criteria_unmet` 5, `abstained` 6, with a positive and a negative each), `backfill.spec.ts` 9 (judge label flips the trial between `judge_criteria_unmet` and `grader_disagreement`). Web `vitest run` 234 of 234, `vue-tsc --noEmit` exit 0, `npx tsc --noEmit` exit 0, `npm run build` exit 0. The first-pass mutation test (swap rules 1 and last) was not repeated: the rule list is the same structure and the same tests stand.

**The real P5 database.** Both P5 experiments were finished with nothing pending or running (264 trials). A dump was taken first (`C:\hx\p6\p5run-pre-0003.dump`, outside the repo). `git archive` of commit `e7e21cb` replaced `C:\hx\p5src\api`, `docker compose -p p5run up -d --build api` rebuilt and recreated only the `api` container, which applied `0003` at start (the CHECK stayed `NOT VALID` with the 85 failed trials uncategorized), then `docker compose -p p5run exec api npm run failures:backfill -- --sample 5` updated 85 of 85 and validated the CHECK (0 failed trials without a category). The `p5run` web container was not rebuilt (it still serves the P4 UI, which does not list the new categories; its Compare page is unaffected). The db, worker and web containers were not restarted. Histogram, all 85 failed trials of both P5 experiments (the secondary experiment finished since the first pass, which is why it is larger):

| experiment, config | failed | step_exhaustion | wrong_tool_usage | tool_error_unrecovered | no_final_answer | judge_criteria_unmet | abstained | wrong_answer | other 5 |
|---|---|---|---|---|---|---|---|---|---|
| primary, memory off | 29 | 5 | 3 | 0 | 4 | 12 | 5 | 0 | 0 |
| primary, memory seeded | 7 | 0 | 0 | 0 | 0 | 6 | 0 | 1 | 0 |
| secondary, memory off (`model-b`) | 28 | 5 | 3 | 1 | 1 | 11 | 5 | 2 | 0 |
| secondary, memory off (`claude-haiku-5.5`) | 21 | 0 | 0 | 0 | 0 | 8 | 10 | 3 | 0 |
| all | 85 | 10 | 6 | 1 | 5 | 37 | 20 | **6 (7.1 percent)** | 0 |

The stop condition is cleared: `wrong_answer` fell from 71.1 percent (first pass, 45 trials) to 7.1 percent (6 of 85). The primary experiment alone: 1 of 36. The 5 "other" categories (`timeout`, `hallucinated_tool_args`, `gave_up_early`, `grader_disagreement`, `memory_ignored`) are still 0 in the real data (Found 5 stands). What is left in `wrong_answer` (6): `det-05-rename` seeded (a real wrong file state), `mem-03-config` memory off "I need the exact contents of the standard configuration you want" (an abstention the patterns miss: "I need"), `mem-04-cron-tz` x3 that answered or hedged UTC ("most likely UTC, but I can't confirm" is hedged, not an abstention), and `mem-05-lint` (claude-haiku-5.5) that ran the lint and listed both modes without `--strict`. No rule was added for them. `tool_error_unrecovered` is 1 (was 1 on a benign grep before; the one left is a real error); `no_final_answer` is 5 (3 are the "reply was cut off" notice on exact_match tasks, 2 are replies without a FINAL line).

**Findings that changed.** Found 1 (stop condition): cleared as above. Found 2 (rule 5 on a benign `grep`): fixed by decision 3; the trial `01M5SRTYYG1J2AHXZX6RS871D5` is now `no_final_answer` (a question without a FINAL line). Found 3 (`wrong_tool` name): fixed by decision 2; the 6 `wrong_tool_usage` trials are all `mem-05-lint` runs without `--strict`. Found 6 (real database not backfilled): done as above. Found 7 still applies to any later upgrade. New: **(a)** `abstained` is a list of phrases, so a reply worded differently ("I need ...") is missed, and a reply that merely ends with a question mark counts; both were read on the data above (20 trials, all sampled ones were real abstentions or questions). **(b)** `judge_criteria_unmet` is 43.5 percent of all failures (37 of 85): every judged task that fails lands there until a label says otherwise, which is its purpose, but it means the histogram's largest bar is the judge's verdict, and the judge's validity (the P5 labels, not yet made) bears on 37 of 85 failures. **(c)** The `.playwright-mcp/` folder and the `p6verify` volumes (and the database copies in them) were removed; the worktree `C:\hx\p6\wt`, the `p6verify` images and the dumps in `C:\hx\p6\` are left.

### Next action

P6 is done and deployed on the P5 database. Run `failures:backfill` again after `judge:kappa` has imported `labels.jsonl`, so that `grader_disagreement` can appear (the 37 `judge_criteria_unmet` trials are the ones a label can move). To rebuild the `web` container of `p5run` on the P6 UI: `git archive HEAD web | tar -x -C /c/hx/p5src`, then `docker compose -p p5run up -d --build web` from `C:\hx\p5src`. To get an isolated P6 stack again: `docker compose -p p6verify -f C:\hx\p6\compose.p6.yml up -d --build` (set the Docker variables first; its volumes were removed, so restore a dump into it).

---

## P5 follow-up: Isolation fix (the trial's spec.json, which holds the graders, is no longer next to the agent)

Cause: P5 Found 2. The runner wrote `spec.json` (the whole TrialSpec: every grader, the expected answers, the `trace_check` regexes) into `trial_dir`, one level above the workspace where the agent's shell starts, and kept it for the whole run. 7 of 66 `claude-haiku-5.5` trials of the secondary experiment opened it. Only `worker/` was touched.

### Shipped

- `worker/runner.py`: `_spec_path(cfg, parsed)` puts the child's spec at `<work_dir>/specs/<trial_id>-<attempt>.json`, outside every trial dir. `run_trial`'s `finally` unlinks it (a child that never started leaves it otherwise). New invariant, named R-10 in the code comments: the spec is never under `trial_dir`.
- `worker/run_one.py`: `consume_spec()` reads the spec and deletes the file as the first thing the child does, before `adapter.prepare()`; if the file cannot be deleted the child raises (fails closed, `worker_crash`) rather than run the agent. `assert_trial_dir_holds_no_extras()` runs before `prepare()` and raises if `trial_dir` holds anything but `workspace`, `out`, `home` and `tmp`. What may exist during `run()` is therefore those four (all created by the runner; `home` and `tmp` are the child's `HOME` and `TMPDIR`, empty) plus the harness's own home that `prepare()` adds (`hermes_home` for Hermes, `memory` for the minimal loop). This is how I read "nothing except workspace/, out/ and the harness home": `home` and `tmp` were left where they are, because moving them changes the H-2 isolation setup, which the task said not to touch.
- Tests: the stub model gets a scenario `read_graders` whose one shell call is `LEAK_PROBE` (`cat ../spec.json`, `find .. -name "*.json"`, and a listing of `..`); `test_adapter_conformance.py::test_r10_an_agent_that_goes_looking_for_the_graders_finds_none`, parametrized over both adapters, runs it against a task whose expected answer is a sentinel and asserts the shell ran (a control string), the sentinel is not in any tool result, `spec.json` and `"graders"` are not either, the listing of `..` is a subset of the runner's and the harness's directories, and no `spec.json` remains under the trial dir or in `specs/`. `test_spec_isolation.py` (6 tests): the fake adapter lists `trial_dir` during `run()` (new mode `list_trial_dir`), a kept trial dir never holds the spec, the spec is gone after a child crash, `consume_spec` reads then deletes, an undeletable spec is not run, a stray file stops the child. The H-8 test read `trial_dir/spec.json` in a fresh process; it now rebuilds the same payload from the run's spec and paths.

### Verified

| Check | Result |
|---|---|
| Worker suite, container (`docker build ./worker` as image `p5iso-worker`, `pytest -q -rf`, tasks mounted read-only) | exit 0, **613 passed, 28 skipped** in 667.57 s, 0 failed. Before: 606 passed, 27 skipped (P3, P5 gates). The difference is 7 new passing tests (2 conformance, 5 isolation) and 1 new skip (the undeletable-spec test cannot run as root). |
| Mutation 1 | `_spec_path` returned `trial_dir/spec.json` again and `consume_spec` stopped deleting. `-k r10`: **4 failed, 3 passed**, 1 skipped: both conformance cases (hermes, minimal_loop), `test_r10_the_spec_is_not_under_the_trial_dir_during_the_run` and `test_r10_consume_spec_reads_then_deletes`. The child guard turned the leak into a `worker_crash` here, so this run shows the guard works. |
| Mutation 2 | The same plus `assert_trial_dir_holds_no_extras` removed, so the pre-fix behaviour is back. Conformance test, both adapters: **failed**, with the sentinel in the probe's output, e.g. `...{"expected": "GRADER-SENTINEL-4c1f9e7a"}]}, "memory_seed": null}, "paths": {...}}../spec.json` and `LS-BEGIN home out spec.json tmp workspace LS-END`. Both files restored from copies, sha256 identical before and after (`runner.py` `df501068...`, `run_one.py` `1dffa48e...`). |
| Hermes and the minimal loop | Both adapters pass the new conformance test, so Hermes's terminal tool and the minimal loop's shell see no `spec.json` from the workspace. |

### Found but not fixed

1. **The graders are still readable elsewhere (DESIGN 13.6).** `/tasks` is mounted read-only in the worker and holds every task JSON (the `exact_match` answers) and the `_hidden/` files; an agent that runs `find / -name "*.json"` or `cat /tasks/mem-01-staging-db.json` still reaches them. This fix closes the one path the agent had a reason to try (`..` from the workspace); real confinement (a separate uid or a mount namespace) is still open. The run's own data shows model-a looked in `..` and in `hermes_home`, not in `/tasks`.
2. **The running `p5run` worker is not updated.** Its image was built from `cb7a46d` and still has the old behaviour; the committed secondary experiment (`01M5STXWYMRDGQFJ47DNK5Y83S`) ran under it, so its `claude-haiku-5.5` results on the tasks whose graders are in `spec.json` stay unreliable (P5 Found 2). The primary experiment is unaffected (0 reads of `spec.json` in its 132 trials). To pick up the fix there: `docker compose -p p5run ... up -d --build worker` from an export that contains this commit, when no experiment is running.
3. **Documents not updated** (outside the files I was allowed to touch): ADAPTERS.md section 6 has no row R-10, and DESIGN.md 13.6 and 13.13 still say the graders are readable at `../spec.json`. They should say it is closed and that `/tasks` is the remaining gap.
4. **`home` and `tmp` remain under the trial dir** (see Shipped). They are empty at the start and hold nothing of ours.
5. Host (Windows) pytest was not run; the new conformance case is skipped on Windows by design (a POSIX shell line).

### Next action

Rebuild the worker in `p5run` from a tree that contains this commit when convenient, and if the secondary experiment is to be quoted for model-a, re-run it afterwards (about 32 minutes, 0.06 USD). Update ADAPTERS.md (R-10) and DESIGN.md 13.6 and 13.13.

---

## P5: The real experiment, judge validation, README, results, video script (STOPPED AT THE LABELS)

Everything that does not need `labels.jsonl` is done. The owner writes the 30 labels by hand; then `judge:kappa`, a re-export and the PENDING KAPPA parts of DESIGN 10.4 and 10.5 remain (see Next action). **Blind labelling:** the 30 items are all the judge-graded trials, so do not read `experiments/results/*`, DESIGN 10.4 or 10.5 beyond what they say is withheld, the Compare or trial pages for the 5 judged tasks (`jdg-01` to `jdg-04`, `mem-06`), `analyze.mjs --reveal-judged`, or the P6 section's Found 1 (it counts judged failures per task) until `labels.jsonl` is committed.

### Shipped

- **The experiments** (details below). Primary `01M5SRTYPNZ9EWV1HX8KJGX40N`: Hermes, `openai/gpt-oss-20b`, memory off against seeded, 22 tasks, N = 3 chosen by the pilot rule (the pilot is the full run), 132 trials, 0 errored. Secondary `01M5STXWYMRDGQFJ47DNK5Y83S`: model-a against model-b, memory off, N = 3, 132 trials, 0 errored.
- **`experiments/results/`**: for each experiment `<id>.json` (export with traces, `comparison_runs[0]` is the persisted comparison), `<id>-compare.csv`, `<id>-trials.csv`; and `p5run-db-pre-kappa.sql.gz` (`pg_dump` of the run's database, 676,569 bytes; test-restored into a scratch `postgres:16`: exit 0, 264 trials, 2 experiments, 3 configs, 2 comparison runs). The platform has no import endpoint, so this dump is the only way to bring the experiments back into a database.
- **`experiments/judge-validation/sample.jsonl`**: 30 items, blind (D-15), seed 20261023, 3 per config and task for the 5 judged tasks (those are all 30 judge-graded trials of the primary).
- **`experiments/p5/`**: `setup-pilot.mjs`, `wait.mjs`, `fetch-results.mjs`, `analyze.mjs`, `setup-secondary.mjs`, and a README with the isolated-stack recipe.
- **`README.md`** (setup, tests, smoke test, use, add a task, a harness, a model, reproduce, export, the primary experiment, where the design lives, layout) and **`VIDEO.md`** (timed script, 0:00 to 10:00).
- **`DESIGN.md`**: 10.4 (draft, every number except kappa and what depends on it), new 10.5 (the secondary), 12.2 (estimate against measurement, actual spend), 13.9 to 13.14 (6 limits found in the run).
- No application code was changed by this phase: none of its commits touches `api/`, `worker/` or `web/` (the P6 commits do).

### Run setup

- **Where it ran.** An isolated compose project `p5run` on the same Windows 11 host, built from `git archive cb7a46d` (the P4 commit, so the P6 session's uncommitted work in the same checkout cannot reach it) in `C:\hx\p5src`, with ports 127.0.0.1:3200 (api), 8200 (worker) and 8280 (web), the repo's `.env` by absolute path and `experiments/` bind-mounted from the repo (so `judge:sample` writes into it). Classic builder (`DOCKER_BUILDKIT=0`, `COMPOSE_BAKE=false`). The database is new (`p5run_dbdata`): none of the P1 to P4 rows are in it. Docker Desktop was not running at the start and was started by hand.
- **Settings.** `MAX_CONCURRENT_TRIALS` 2 (printed from the api container), `WORKER_MAX_PARALLEL` 4, `JUDGE_MODEL_ID` `model-a`. The P6 session read the database with `pg_dump` (its own STATE section says so) and wrote nothing to it. The stack still runs the P4 images (no migration `0003`).
- **Configs** (created by `experiments/p5/setup-pilot.mjs` through `POST /configs`; both 201): A `hermes memory off` id `01M5SRTYBWGNJH3HV8N3BHSTKH`, `config_hash` `638fcbb999c8fb535e7aa8155bc13fc148cc0bed241d0e91240c11459890ae66`; B `hermes memory seeded` (`team-memory-v1`) id `01M5SRTYKGT14BBXBCKFV1ANYQ`, `config_hash` `1b359ab5b8b402d225622f3bc0861813bd15b77126232645038d0aaf5b2af88e`. Both: harness `hermes` (commit `f4ac0bea1e`), `model-b` = `openai/gpt-oss-20b`, tools `[shell, files]`, skills off, temperature 0, `max_steps` 15, `max_output_tokens` 2048, `timeout_seconds` 300, `harness_options.providers_ignored = ["Darkbloom", "Groq"]` (DESIGN 13.5).
- **Experiment** `01M5SRTYPNZ9EWV1HX8KJGX40N`, "P5 primary: hermes memory off vs seeded", draft with phase `pilot`, `n_trials` 3, `seed` 20261025, the 22 tasks as an explicit `task_ids`, axis `hermes memory off vs seeded`, and the hypothesis read from DESIGN.md 10.1 by the script (H1 to H3, verbatim, and the API echoed it back). Started 2026-10-25T14:53:34.813Z.

### Pilot (N = 3), the numbers the decision used

`GET /experiments/01M5SRTYPNZ9EWV1HX8KJGX40N/pilot`, after the experiment finished `completed` at 2026-10-25T15:22:32.937Z (29.0 minutes for 132 trials at concurrency 2): 132 done, 0 errored, 0 cancelled, 0 pending.

| field | value |
|---|---|
| ready | true |
| n_pilot, n_tasks, n_judged_tasks, n_configs | 3, 22, 5, 2 |
| n_cells_used | 44 of 44 |
| within_task_variance (s2) | 0.06060606060606062 |
| Bernoulli worst case (0.25) | h(3) 0.1706, h(5) 0.1321, h(8) 0.1045 |
| h(N) with the observed s2, T = 22 | **h(3) 0.083996**, h(5) 0.065063, h(8) 0.051437 |
| h(N) with the observed s2, the 5 judged tasks removed (T = 17) | h(3) 0.095553, h(5) 0.074015, h(8) 0.058514 |
| trials for N = 3, 5, 8 | 132, 220, 352 |
| `recommended_n`, `capped` | 3, false |

### N decision

The rule (DESIGN 9.7, card section 7 S2): the smallest N in {3, 5, 8} with h(N) <= 0.15, where h uses the observed s2. h(3) = 0.083996 <= 0.15, so **N = 3**. The endpoint, which tries every integer from the pilot's N up to the cap of 8, returned the same 3. The pilot has the 3 trials per cell that the rule asks for, so the pilot is the full run: `extend` is **not** called, no trial is added, and the run is the 132 trials above.

Why this is not N = 5 as DESIGN 10.2 expected: that expectation used the worst-case variance 0.25 (h(5) = 0.132). The observed within-task variance is 0.0606, a quarter of that, because most cells are all-pass or all-fail at temperature 0. The pre-registered rule says to trust the pilot over the bound, so the bound's N = 5 is not used. Two things the rule does not cover, said now so they are not found later: (1) h(N) shrinks only the within-task noise; between-task spread is not reduced by N and enters the task-level bootstrap interval directly, so the real interval is expected to be wider than 0.084; (2) the reported `min_detectable` of the aggregate and of each category (6, 2, 2 and 8 tasks) is what this N could resolve, and DESIGN 10.4 reports it next to each verdict. Cost of the choice: 132 trials instead of 220.

No pass rate, delta, verdict or comparison payload was read before this section was written (the compare endpoint was not called; the trial list was fetched once to look at the event shape of a trace, and its `passed` values were not read).

What happened after N was written, in order: 51a181c (this section's first half) was committed; then `GET compare?persist=1` (comparison run `01M5STJJ4S53KD0KKACEQRH5V6`, stats 1.0.0, policy `excluded`), the export, `analyze.mjs`, `judge:sample -- --n 30`; f147871 committed the results, the sample and the DESIGN drafts; then the secondary experiment (started 2026-10-25T15:30:08Z, finished 16:02:34Z, 32.4 minutes) and the gates.

### Verified

| Gate | Result |
|---|---|
| 1 Harness | No code was changed, so no suite changed. The suites of the code the run used (`cb7a46d`) are N of N in the containers, row 2. Mutation test: not applicable (no code); the statistic that carries the verdict was already mutation-tested in P3 (the claim query) and P4 (the noise rule in the UI). |
| 2 Audit (containers, `p5run`, images built from `cb7a46d`) | `docker compose exec api npm test`: exit 0, `Test Suites: 1 skipped, 34 passed, 34 of 35 total`, `Tests: 3 skipped, 619 passed, 622 total` (the 3 skipped are the stub walk, no Python in the api image), 619 of 619 that can run. `docker compose exec worker pytest -q -rf`: exit 0, `606 passed, 27 skipped` in 624.53 s, 0 failed. Both numbers equal the P3 close-out (the P4 and P5 phases did not change either side). The web image built with exit 0 (its build stage runs the Vitest suite and `npm run build`, P4). |
| 3 Typecheck and build | `docker compose exec api npx tsc --noEmit -p tsconfig.json`: exit 0, no output. `docker compose -p p5run build api worker web` (classic builder) built all 3 images from the `git archive` of `cb7a46d`, exit 0. |
| 4 The walk | **Partly done.** Checked in the stack: `docker compose exec api npm run tasks:lint` (the README's add-a-task command) printed `22 task(s) and 1 memory fixture(s) OK`; the README's worker test path (`tests/test_adapter_conformance.py` from `/app/worker`) was read off the container's working directory; **Not done:** a fresh clone with `docker compose up` (it would replace the default stack another session uses), opening the committed experiment by id on such a stack (impossible: there is no import endpoint, see Found 5), and the timed run of VIDEO.md. The 3 trajectories named in DESIGN 10.4 were opened as data in the export and every named event was checked against it (`mem-01` off `01M5SRTYYFKEFMG9GHK40QFHQF` events 3 to 45 and its grader `extracted: unknown:unknown`; seeded `...QG` events 0, 1, 4, 5; `dis-02` `01M5SRTYY6R7KHEJ98VH07GYVQ` events 0, 5, 8; `det-05` `01M5SRTYYG1J2AHXZX6RS871CE` events 5, 8, 15), not in a browser. |
| 5 Live | Both exports parse and `comparison_runs[0].result` equals a fresh `GET compare?persist=0` field for field (`fetch-results.mjs` prints `true` for both, same seed and stats version): primary `01M5SRTYPNZ9EWV1HX8KJGX40N` and secondary `01M5STXWYMRDGQFJ47DNK5Y83S`. Both are pre-kappa (policy `excluded`); the re-export after kappa replaces them. |

**The run, in numbers** (all from the committed exports; DESIGN 10.4, 10.5 and 12.2 have the tables):

- Primary: 132 trials, 132 done, 0 errored, 0 cancelled, 0 retried by the scheduler, 0 with `rate_limit_events`; exit reasons 124 `completed`, 6 `max_steps`, 2 `invalid_tool_call`. Pilot s2 = 0.0606, h(3) = 0.0840, chosen N = 3. Headline over the 17 non-judged tasks (policy `excluded` until kappa): A (off) 0.667, B (seeded) 0.980, delta (A - B) -0.314, 95% CI [-0.549, -0.098], `B_better`, min detectable 0.225. `memory_dependent` (5 of 6 tasks): 0.000 against 1.000 (0 of 15 against 15 of 15), delta -1.000. `memory_distractor` [0, 0], neutral [-0.125, 0.125], honesty [-0.333, 0], all `noise`. Sign test A 1, B 7, 9 tied, p = 0.0703. Per call the memory block adds 1,136 input tokens (H3 assumed about 800); per trial the seeded config used 22,842 input tokens against 27,068 and cost 0.000437 against 0.000523 USD.
- Secondary (model-a against model-b, memory off, 17 tasks): 0.745 against 0.667, delta +0.078, CI [0.000, 0.176], `noise`, min detectable 0.088. `mem-05-lint` passed 2 of 3 under model-a (discoverable from `lint.py`, and both passing trials also read `spec.json`).
- Spend: primary 0.0634 USD candidates + 0.0141 judge = 0.0775; secondary 0.0460 + 0.0150 = 0.0610 (a floor, Found 3); both 0.139 USD. The card's 25 USD stop was never close.
- Stop conditions of card section 9: none reached. The pilot did not show every memory-dependent task at one pass rate (0 against 1); 0 of 264 trials errored; kappa is pending; spend 0.139 USD.

### Cut on purpose

- **The 30 labels, `judge:kappa`, and everything that depends on kappa**: the headline over 22 tasks, `neutral_judged` and `mem-06`, the 5 missing per-task rows, DESIGN 10.4 "Judge validation" and the conclusion's judged parts. They are marked PENDING KAPPA and wait for the owner's `labels.jsonl`.
- **`extend`**: not called, because the rule gave N = 3 (N decision above).
- The fresh-clone README walk and the timed VIDEO.md run (gate 4), and the recording (the owner's).
- Any change to code or to the UI; no defect was found that needed one. Not built: a restore script for `p5run-db-pre-kappa.sql.gz` (the commands are in `experiments/p5/README.md` terms, and the restore was tested by hand).

### Found but not fixed

1. **Hermes retries are invisible in totals and one notice blames the wrong cause.** 30 `api_call` events (28 `retry`, 2 `error`), no HTTP status, 0 tokens, in 11 of 132 primary trials (8 off, 3 seeded); 18 events in 7 of 132 secondary trials. In 2 primary and 2 secondary trials Hermes gave up after 5 and the notice "The model's reply was cut off ... output length limit" became the graded `final_response`, exit reason `invalid_tool_call`, although the events show no output. The primary's `hon-01` off pass rate (0.67) and with it the honesty group's -0.167 come from this one trial (`01M5SRTYY6R7KHEJ98VH07GYVR`). The HTTP-status rule (P2 ruling 1) does not see it, because no status is attached; the P2 safeguard of counting scored `agent_error` trials without status finds 0 here because these trials end as `invalid_tool_call`. DESIGN 13.9.
2. **The confinement gap was exercised (DESIGN 13.6, now 13.13).** 7 of 66 `claude-haiku-5.5` trials opened `/work/trials/<id>/1/spec.json` (the graders) and 10 named `hermes_home`. `gpt-oss-20b` opened `spec.json` in 0 of 198 trials. The primary experiment is clean on this point (0 reads of `spec.json`, 1 listing of `hermes_home` whose `memories/` was empty); the secondary's memory-dependent and `trace_check` results under model-a are not. `analyze.mjs` first matched `../spec.json` only and missed absolute paths; it was fixed and rerun on both exports.
3. **Cached tokens are priced at 0 (P1 found 4, now 13.14).** The secondary run had cache hits for both configs (1,223,265 and 699,574 tokens over 66 trials each), the primary none, for the same model-b config run 8 minutes apart: routing is not pinned. `cost_usd` there is a floor and the ceiling (cached tokens at the full input price) is up to 6.2 times higher for model-a. The cost half of HS2 cannot be judged from the platform's number. `harness_cost_usd` (Hermes's estimate) is 32 percent above the platform's figure in the primary (0.0835 against 0.0634) and was not explained.
4. **N = 3, not the expected 5.** DESIGN 10.2 and 9.7 still say "expected 5" (pre-registered text, left as written). The pilot endpoint tries every integer from 3 to 8, the card says {3, 5, 8}; both give 3 here. Resolution: 2-task groups can take few values, `min_detectable` says what they could see (13.10).
5. **No import endpoint, and the data's only live copy is the volume `p5run_dbdata`.** `experiments/results/*.json` is the record but cannot be loaded; `p5run-db-pre-kappa.sql.gz` can (restore into a fresh `postgres:16`, tested). The kappa row and any re-export live in the volume only until a new dump is taken. The stack is outside the repo (`C:\hx\p5src`, made by hand from `git archive cb7a46d` with 3 edits to `docker-compose.yml`, recipe in `experiments/p5/README.md`), so "follow the README from a fresh clone and open the experiment by id" (gate 4) does not hold for this data.
6. **The committed exports are pre-kappa and contain every judge verdict.** They (and DESIGN 10.4 and 10.5, which withhold the judged rows) are unblinding for the labeler if opened early. The compare numbers in them apply policy `excluded`; after kappa `fetch-results.mjs` overwrites the files of the same names.
7. **The pilot stack runs the P4 images.** P6's migration `0003` (failure categories) is not applied there, so its Compare page has no failure table and the trial page no category; P6's STATE section (Found 6) has the upgrade steps. Doing it while labels are pending is safe (no run is active); do it once, then `failures:backfill`.
8. **H3's size of the memory block was off** (800 assumed, 1,136 measured, fixture files 881 characters against "about 2,000"); DESIGN 10.1 is pre-registered text and was left as written, 10.4 states the measurement.
9. **Gate 4's timed run of VIDEO.md did not happen.** The script's time marks are an allocation, not a measurement.
10. **ESLint, Prettier and `npm audit` were not run.** The new scripts are plain `.mjs` files without tests: `fetch-results.mjs` ends with a self-check (gate 5), the other four have none.
11. **The default compose stack (`agent-evals-harness`, ports 3000 and 8080) holds the P1 to P4 rows and stopped when Docker Desktop was closed; it was not touched.**

### Assumptions resolved

- **A-10** (token volume per trial): measured. Estimate 6 calls, 6,000 input and 300 output tokens per call, 36,000 input and 1,800 output tokens per trial. Measured (132 primary trials): 4.42 calls, 5,650 input and 78 output tokens per call, 24,955 input and 344 output tokens per trial; 3,294,030 input and 45,433 output tokens in all; spend 0.0634 USD for the candidates (0.107 USD predicted at the same prices) and 0.0141 USD for the judge. DESIGN 12.2 has the table.
- **A-7** (auxiliary call tokens): still partly. Hermes's own estimate is 32 percent above ours in the primary and 2.4 times (model-a) and 1.1 times (model-b) in the secondary; retried calls carry no tokens (Found 1). Whether auxiliary calls exist was not isolated.
- **Card section 10 defaults:** Q1 moot (the rule gave N = 3, projected spend far under 15 USD). Q2 used: trajectory 1 the `memory_dependent` fail/pass pair, 2 a `memory_distractor` trial (both configs tied, so the seeded one that could have gone wrong), 3 the only delta outside the memory category in A's favour (`det-05`), because the largest delta outside memory is a judged task. Q3 applied: the primary was `completed` and spend was under 10 USD, so the secondary was run (DESIGN 10.5). Q4 not applicable.
- **Pre-registered hypotheses:** H1 holds on the 5 non-judged memory tasks; H2 is not contradicted at this resolution; H3 holds per call and not per trial (DESIGN 10.4). HS1 is false for `mem-05`; HS2 holds in direction (DESIGN 10.5).
- **Decision on P2 found 1** (scored trials without HTTP status): no change; count and report. Result: 0 such trials; the related case is Found 1 above.

### Next action

The owner:

1. **Label.** Read only `experiments/judge-validation/sample.jsonl` (30 lines, each with the task prompt, the rubric and the text the judge saw). Write `experiments/judge-validation/labels.jsonl`, 1 object per line: `{"trial_id": "...", "grader_index": 0, "human_passed": true, "labeler": "author"}` (`human_passed` is true only when every rubric criterion is met; format in `experiments/judge-validation/README.md`). Do not open the Compare or trial pages for `jdg-01` to `jdg-04` and `mem-06`, `experiments/results/`, or the judged rows of DESIGN 10.4 and 10.5 until the file is committed.
2. **Kappa.** `docker compose -p p5run -f C:/hx/p5src/docker-compose.yml exec api npm run judge:kappa` (set `DOCKER_BUILDKIT=0` and `COMPOSE_BAKE=false` first). It prints agreement, kappa, the 95% interval and the policy. If kappa is below 0.4: do not re-label (card section 9); the `excluded` headline stands and the judged tasks go in a separate table.
3. **Re-export and fill in.** `node experiments/p5/fetch-results.mjs 01M5SRTYPNZ9EWV1HX8KJGX40N` and the same for `01M5STXWYMRDGQFJ47DNK5Y83S`; `node experiments/p5/analyze.mjs experiments/results/<id>.json --reveal-judged`; replace every PENDING KAPPA in DESIGN 10.4 and 10.5 (headline over 22 tasks, 22-row per-task table, `neutral_judged`, the `mem-06` part of H1, the judged leak counts, kappa with its interval); take a new dump (`pg_dump` as in `experiments/p5/README.md`) and replace `p5run-db-pre-kappa.sql.gz`; commit.
4. **Optional, P6:** upgrade `p5run` (Found 7) and run `failures:backfill` once more after `judge:kappa`.
5. **Video:** record after step 3 on the `p5run` stack (<http://localhost:8280>), following `VIDEO.md`; time it and write the duration here. Do not run `down -v` on `p5run`.

To get the stack back after a reboot: set the Docker variables, `docker compose -p p5run -f C:/hx/p5src/docker-compose.yml up -d`, `ps`. If `C:\hx\p5src` is gone, rebuild it as in `experiments/p5/README.md` and restore the dump into the new `db`.

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
