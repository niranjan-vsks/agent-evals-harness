# DEMO_GUIDE.md

How to operate the recording: what to prepare, what to click, what each screen must show, and what to do when something goes wrong. SCRIPT.md has the words; this file has the mechanics.

---

## 1. Solving the runtime problem

A real experiment takes minutes: the primary ran 132 trials in 29.0 minutes (DESIGN 10.4). You have 10 minutes. So:

| what | how it appears in the video | why |
|---|---|---|
| **The real experiment** (`01M5SRTYPNZ9EWV1HX8KJGX40N`, 132 trials) | **pre-run and persisted**: it is already in the `p5run` database. You open it; you do not run it | it is the evidence, and its numbers are final |
| **A live mini-run**: 2 tasks x 2 configs x N = 1 = **4 trials** | **started live** at about 3:15, runs in the background while you show Compare, revisited at about 7:45 | authenticity: the viewer sees the platform actually run trials |
| the deck | pre-opened in its own window | no loading on camera |

**Why these 2 tasks.** `det-06-ini` and `mem-05-lint` are among the fastest trials in the export: 14.2 to 24.8 s for `det-06`, 16.2 to 22.7 s for `mem-05` (`latency_ms`, primary export). At concurrency 2 the 4 trials run in 2 rounds. Their outcomes in the real run were all the same within each cell (det-06 passed 6 of 6; mem-05 failed 3 of 3 under off and passed 3 of 3 under seeded), so the live result is predictable and does not shift the Overview's pass rates.

**Where to cut.** You may record in 4 segments and join them; every join is a section boundary in SCRIPT.md:

1. the deck (0:00 to 1:45)
2. Overview, Configs, starting the live run (1:45 to 4:00)
3. Compare and the trials (4:00 to 6:45)
4. code, the live result, the close (6:45 to 8:30)

If the live run is not finished at 7:45, cut, wait, and resume on the finished page. Never leave silence on camera while a run progresses.

---

## 2. Pre-flight (do it in this order, the day of recording)

### The stack

1. Open Docker Desktop.
2. In Git Bash:

   ```
   export DOCKER_BUILDKIT=0 COMPOSE_BAKE=false
   docker compose -p p5run -f C:/hx/p5src/docker-compose.yml up -d
   ```

3. **Rebuild the web container once** (it does not yet have the last web commit, the wordmark linking to the Overview; STATE P8):

   ```
   cd "/c/Users/NIRANJAN VSKS/OneDrive/Desktop/Niranjan_Stuff/agent-evals-harness"
   git archive HEAD web | tar -x -C /c/hx/p5src
   docker compose -p p5run -f C:/hx/p5src/docker-compose.yml up -d --build --no-deps web
   ```

4. **Do not rebuild `api` or `worker`.** The worker is the old image, and a new worker behind p5run's old compose file fails every trial closed (STATE "Audit fixes (code)", Found 1).
5. **Never run `down -v` on p5run.** It deletes the only live copy of the data (STATE P5 Found 5).
6. `docker compose -p p5run -f C:/hx/p5src/docker-compose.yml ps`: `db`, `api`, `worker`, `web` all healthy.
7. Use **<http://localhost:8280>**. Not :8080: the repo stack does not hold the experiments.

### Rehearse the live run once, and record the new totals

The live part has not been run on p5run since the API was rebuilt for P8 (it runs the new API with the old worker). Whether a trial runs end to end there is **[NOT MEASURED]**. Do 1 full rehearsal of section 5 of this guide before recording. Then:

- the rehearsal leaves an experiment behind, and nothing in the UI deletes it;
- **after the rehearsal, open the Overview and write the 6 tiles down here:** experiments ___, trials done ___, spend ___, best ___, errored ___, tasks ___. Those are the values you will see on camera, not the base values in section 3.

### The browser

- A fresh browser profile or guest window: no bookmarks bar, no extensions, no signed-in avatar, no autofill.
- 1 tab, window about 1,400 px wide, zoom 100 percent.
- Theme **dark** (the toggle in the top bar; it is remembered in the browser).
- Pre-open the deck (`docs/deck.html`) in a **separate** window, full screen (F11).

### The editor (for the code segment)

- Open only the 3 files, in this order: `api/src/stats/compare.ts`, `worker/adapters/base.py`, `worker/runner.py`.
- Close the file explorer side bar, the terminal panel and any other tabs. Font size about 16. Dark theme.
- Never open `.env` and never run `cat .env` or `env` in a visible terminal.

### The machine

- Turn on Windows Do Not Disturb. Quit chat, mail and calendar apps.
- Hide the desktop icons and the taskbar clock if you like. Close any window whose title shows personal folders.
- Record the screen at 1080p with 1 microphone. Test the audio level once.

---

## 3. Exact expected values, screen by screen

The base state is the post-kappa database: 2 experiments, 264 trials (DESIGN 10.6). The values below are the ones measured on the refreshed `p5run` stack (api, worker and web rebuilt from `eabb676`) **after 1 rehearsal of the live run**, experiment `01M5ZA546VKGJ850QY1KC7JJV1` (section 3.7). Where the base differs, it is in brackets. Every further rehearsal adds to the counts.

### 3.1 Overview, `http://localhost:8280/`

| element | expected (base state) | source |
|---|---|---|
| Experiments tile | **3** [base 2], with "3 configs, 2 models, 2 harnesses" | `/summary` after the rehearsal |
| Trials done | **268** [base 264] | `/summary` after the rehearsal |
| Spend | **0.11 USD**, "0.111513 USD over done trials" [base 0.109366] | `/summary` after the rehearsal |
| Best pass rate | **0.894**, `hermes memory seeded` (unchanged) | `/summary` after the rehearsal |
| Errored trials | **0** | `/summary` after the rehearsal |
| Tasks | **22**, "current versions" | `/summary` after the rehearsal |
| Latest verdicts | 2 rows (unchanged: the rehearsal persisted no comparison), both `stats_version` 1.1.0, judge trusted, reliability complete. Likely order: newest first, so the **secondary** (computed 00:32:53Z) above the **primary** (00:32:50Z) | export `comparison_runs[1].computed_at` |
| verdict row, primary | interval **-0.333 [-0.515, -0.167]**, pill **B better by 0.333 [0.167, 0.515]** | compare.csv; CompareView format |
| verdict row, secondary | interval **0.106 [0.030, 0.197]**, pill **A better by 0.106 [0.030, 0.197]**. On camera: "no reliable difference" | DESIGN 10.5 |
| Pass rate per config | seeded **0.894** (accent bar), `hermes memory off, claude-haiku-5.5` **0.682**, `hermes memory off` **0.575** [base 0.568: the rehearsal's `mem-05-lint` passed under off] | `/summary` after the rehearsal |
| Cost against pass rate | 3 points, mean cost per trial: seeded 0.000438, haiku 0.000358, off 0.000439 USD [base 0.000437, 0.000358, 0.000431] | `/summary` after the rehearsal |
| Failure categories | unchanged by the rehearsal (all 4 trials passed). 8 rows: judge_criteria_unmet **36**, abstained **20**, step_exhaustion **10**, wrong_tool_usage **6**, wrong_answer **6**, no_final_answer **5**, tool_error_unrecovered **1**, grader_disagreement **1**; caption "4 categories have 0 and are not listed" | STATE "Judge validation"; exports |
| Recent experiments | 3 rows, the rehearsal on top: "Demo rehearsal: memory off vs seeded, live" completed 4 / 4, then "P5 secondary: model-a vs model-b, hermes memory off" and "P5 primary: hermes memory off vs seeded", both completed, 132 / 132 | `/summary` after the rehearsal |

Each rehearsal adds 1 to Experiments and 4 to Trials done (268 after 1), and Recent experiments shows it on top. The first one added 0.002147 USD of spend, and it moved the `hermes memory off` bar from 0.568 to 0.575, because its `mem-05-lint` trial passed. The pass-rate bars therefore can move by a few thousandths when the 4 trials do not repeat the real run. The seeded bar and the best pass rate did not move. If the rehearsal experiment is removed, the base values in brackets apply.

### 3.2 Configs, `/configs`

- At least 3 rows: `hermes memory off`, `hermes memory seeded`, `hermes memory off, claude-haiku-5.5`.
- The refusal: choose harness `minimal_loop`, model `openai/gpt-oss-20b`, tick **skills enabled**, submit. Expected reason: **"the minimal loop has no skills; skills.enabled must be false"** (`worker/adapters/minimal_loop/adapter.py`, line 105). The heading text in P4 was "config refused: the harness cannot honor these settings exactly" (VIDEO.md); read whatever heading is on screen.
- **Do not then create the config** (unticking and submitting would add a 4th config to every count). Clear the form or navigate away.

### 3.3 Experiment detail of the primary, `/experiments/01M5SRTYPNZ9EWV1HX8KJGX40N`

| element | expected | source |
|---|---|---|
| name, status | "P5 primary: hermes memory off vs seeded", completed | export |
| axis | "hermes memory off vs seeded" | export |
| N, seed | 3, 20261025 | DESIGN 10.4 |
| hypothesis | starts "H1: on `memory_dependent` tasks, the seeded config's pass rate exceeds the off config's by at least 0.5 absolute" | export, DESIGN 10.1 |
| progress | 132 of 132 done, 0 errored | DESIGN 10.4 |
| pilot panel | ready; s2 0.0606; observed h(3) 0.0840, h(5) 0.0651, h(8) 0.0514; worst case 0.1706, 0.1321, 0.1045; recommended N **3**, capped false | STATE P5 "Pilot" |

### 3.4 Compare of the primary

URL: `/experiments/01M5SRTYPNZ9EWV1HX8KJGX40N/compare?a=01M5SRTYBWGNJH3HV8N3BHSTKH&b=01M5SRTYKGT14BBXBCKFV1ANYQ`

| element | expected | source |
|---|---|---|
| badges | reliability: complete; judge policy: trusted; rate-limit affected trials: 0 | payload |
| A, B | `hermes memory off`, `hermes memory seeded` | payload |
| axis | settings differ in memory only | DESIGN 1 |
| aggregate | A **0.561**, B **0.894**, delta **-0.333 [-0.515, -0.167]**, pill **B better by 0.333 [0.167, 0.515]**, min detectable **0.174** | payload |
| memory_dependent (6) | -0.944 [-1.000, -0.833], B better | payload |
| memory_distractor (2) | 0.000 [0.000, 0.000], noise | payload |
| neutral (12) | -0.111 [-0.250, 0.028], noise | payload |
| honesty (2) | -0.167 [-0.333, 0.000], noise | payload |
| sign test | A 1, B 11, ties 10, p 0.0063 (it may show as 0.006) | payload |
| McNemar | omitted: "McNemar needs 1 binary outcome per (task, config) pair; this experiment has 3 trials per task" | payload |
| per-task table | 22 rows, "direction only" caption; mem-01 to mem-05 at -1.00 [-1, -1] | compare.csv |
| failure categories | A: judge_criteria_unmet 12, step_exhaustion 5, abstained 5, no_final_answer 4, wrong_tool_usage 3 (29). B: judge_criteria_unmet 5, grader_disagreement 1, wrong_answer 1 (7) | payload |
| cost per trial | A 0.000523, B 0.000437 USD; delta interval [-0.000087, 0.000296] | payload |
| latency per trial | A 25.9 s, B 20.5 s; delta [1.6, 9.8] s | payload |
| input tokens per trial | A 27,068, B 22,842 | payload |

### 3.5 The failed trial: `01M5SRTYYFKEFMG9GHK40QFHQQ`

URL: `/trials/01M5SRTYYFKEFMG9GHK40QFHQQ` (from the trials table: task `mem-05-lint`, config `hermes memory off`, trial index 0).

**Why this trial.** Its cause is visible in 3 events and explainable in 60 seconds. The agent read `lint.py`, whose code shows a `--strict` mode exists, ran the plain command anyway, got PASS, and reported PASS. The task's answer is FAIL, because the team runs it strict, and that fact is only in memory. 2 graders catch 2 different things: the wrong answer, and the missing mechanism. It also shows the failure-category feature. It is better than the `mem-01` trial in VIDEO.md, which needs 15 steps to scroll through.

| element | expected | source |
|---|---|---|
| verdict, exit | **FAIL**, exit reason `completed`, **4** steps | export |
| category | `wrong_tool_usage`, rule 4, evidence "grader #1": "trace_check tool_called failed: 0 of 1 call(s) of shell match 'lint\.py\s+--strict'" | export |
| grader 0, exact_match | failed: expected `FAIL`, extracted `PASS` | export |
| grader 1, trace_check | failed: 0 of 1 calls of `shell` match `lint\.py\s+--strict` | export |
| facts | 18,089 input tokens, 151 output, 0.000339 USD, 19.2 s | export |
| timeline | no `memory_read` event. #3 `search_files` "lint"; #6 `read_file lint.py`; #7 result shows `if strict:` and `"--strict" in sys.argv`; **#9 shell `python lint.py`**; #10 result `PASS`, exit 0; **#12 `FINAL: PASS`** | export trace |

### 3.6 The passing twin: `01M5SRTYYFKEFMG9GHK40QFHQR`

URL: `/trials/01M5SRTYYFKEFMG9GHK40QFHQR` (task `mem-05-lint`, config `hermes memory seeded`, index 0).

| element | expected | source |
|---|---|---|
| verdict | **PASS**, `completed`, **2** steps, 10,822 input tokens, 0.000204 USD | export |
| #0 `memory_read` MEMORY.md | contains "Lint is run as: python lint.py --strict. Plain python lint.py is too lenient and passes things the CI rejects." | export trace |
| #1 `memory_read` USER.md | `loaded_by: harness` | export trace |
| #5 shell | `python lint.py --strict` | export trace |
| #6 result | `src/app.py:9: line too long (123 > 79)` then `FAIL`, exit 1 | export trace |
| #8 | `FINAL: FAIL` | export trace |

### 3.7 The live mini-run (created on camera)

Form on `/experiments`:

- configs: tick `hermes memory off` and `hermes memory seeded`
- tasks: tick only `det-06-ini` and `mem-05-lint`
- N: **1**
- axis: `memory off vs seeded, live`
- hypothesis: `On these 2 tasks memory changes mem-05 only; with 2 tasks and 1 trial the platform should call it noise.`
- Create, then Start.

Expected while running: 4 trials, at most 2 running at a time. Measured: after 3 s, 2 pending and 2 running; after 33 s, 2 done and 2 running; after 63 s, 3 done and 1 running; completed 66 s after Start (`started_at` 2026-10-27T18:32:25Z, `finished_at` 18:33:32Z).

The form leaves the seed empty and the API draws one; the rehearsal got 1735921113. The Name field is required and the list above does not give one; the rehearsal used `Demo rehearsal: memory off vs seeded, live`. Phase is the form's default, `full`. Config order was off (A), then seeded (B).

**Rehearsal run, measured on 2026-10-27** (experiment `01M5ZA546VKGJ850QY1KC7JJV1`, Compare at `/experiments/01M5ZA546VKGJ850QY1KC7JJV1/compare?a=01M5SRTYBWGNJH3HV8N3BHSTKH&b=01M5SRTYKGT14BBXBCKFV1ANYQ`). All 4 trials ended `done`, 0 errored.

| trial | task | config | passed | latency | cost |
|---|---|---|---|---|---|
| `01M5ZA54AEDQYKT4PHEF9ERF81` | det-06-ini | off | pass | 20.7 s | 0.000162 USD |
| `01M5ZA54AEDQYKT4PHEF9ERF82` | det-06-ini | seeded | pass | 21.3 s | 0.000203 USD |
| `01M5ZA54AFKN362XP5BC4VNP9Y` | mem-05-lint | off | **pass** | 41.4 s | 0.001469 USD |
| `01M5ZA54AFKN362XP5BC4VNP9Z` | mem-05-lint | seeded | pass | 20.6 s | 0.000313 USD |

**The hand-worked prediction did not repeat.** In the real run `mem-05-lint` failed 3 of 3 under off; here, the off trial passed. Its trace: it ran `python3 lint.py` (PASS), then, after more searching, `python3 lint.py --strict` (FAIL, exit 1), and still ended with a passing answer. That is 1 trial per cell, and it is the case the recovery table calls "a live outcome differs". The rows below are what the platform showed.

| element | observed |
|---|---|
| det-06-ini | pass under both |
| mem-05-lint | pass under both |
| aggregate | A 1.000, B 1.000, delta 0.000, interval [0.000, 0.000], verdict **noise** (the interval contains 0), min detectable 0.000 |
| categories | memory_dependent and neutral each 1 task: `insufficient_data` ("1 paired task(s); an interval needs at least 2") |
| per-task rows | `insufficient_data` for both (N = 1 is below 2 trials per side), direction only |
| McNemar | shown (N = 1): A only 0, B only 0, both pass 2, p 1.000 |
| sign test | A 0, B 0, ties 2, p 1.000 |
| failure categories | all 0 for both configs |
| badges | reliability complete; rate-limit affected trials 0; judge policy `trusted` (the payload's default; no judged task is in this run) |
| cost per trial | A 0.000816, B 0.000258 USD; delta interval [-0.000041, 0.001156] |
| latency per trial | A 31.1 s, B 21.0 s; delta interval [-0.6, 20.8] s |
| input tokens per trial | A 43,135, B 13,629 |
| stats version | 1.1.0 |

The next live run may come out differently (mem-05 off failing is the likely alternative). Read the verdict from the screen; with 2 tasks and 1 trial, expect `insufficient_data` in the category and per-task rows either way.

The rehearsal was read through `GET .../compare` without `persist`, and no export was requested, so the Overview's Latest verdicts still show 2 rows.

**Do not click Export on the live experiment.** Exporting persists a comparison, and it would then appear in the Overview's Latest verdicts.

---

## 4. Recovery plan

| what goes wrong | keep rolling or stop | what to say or do |
|---|---|---|
| the live run is slower than expected and not done at 7:45 | keep rolling | "It is still running: N trials of 4 done. The method is the same as the 132 we just looked at." Show the progress, then cut and resume on the finished page if you need the verdict |
| 1 live trial errors (429, 5xx) | keep rolling | "That trial hit a provider error; the platform retries it after 30 seconds and does not score it. This is the reliability badge's job." Point at the status |
| every live trial errors as `worker_crash` | stop, fix, re-record segment 2 | the worker image or the compose mount is wrong (STATE "Audit fixes (code)", Found 1). Do not rebuild the worker on p5run; record without the live part and say "the 132-trial run is the experiment" |
| a live outcome differs (det-06 fails, mem-05 off passes) | keep rolling | "Different from the real run: this is 1 trial per cell. That is exactly why the verdict is noise and why the real run used 3 per cell." Read the verdict on screen; if the interval excludes 0, read it and say "2 tasks, 1 trial: I would not act on it" |
| a number on the primary Compare or Overview differs from section 3 | **stop** | the wrong stack, port or comparison. Check the URL is :8280 and the config ids match. The primary's numbers are stored; they cannot change by themselves |
| the Overview totals differ from section 3 | keep rolling, if they match the numbers you wrote down after the rehearsal | otherwise stop: wrong stack |
| a page shows "payload inconsistent" | stop | the stored verdict and interval disagree; do not record over it |
| the page is blank or the API does not answer | stop | `docker compose -p p5run -f C:/hx/p5src/docker-compose.yml ps`; restart with `up -d` (never `down -v`) |
| you misread a number | keep rolling | correct yourself once in plain words: "sorry, 0.894" |
| a notification or personal window appears | stop, re-record that segment | |
| you run past 9:30 | keep rolling | skip to the close: limits in 1 sentence, then stop |
