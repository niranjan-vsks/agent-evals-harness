# DESIGN.md: Agent Evals Platform

Companion documents: ADAPTERS.md (adapter contracts, frozen), DATA_MODEL.md (schema and
invariants), `cards/P1..P6.md` (build order), STATE.md (what is actually built).
Sections 10.4 and 11 are filled in by the P5 and P2 builders respectively; until then
they are marked `TBD` on purpose.

---

## 1. The question, and what this platform can and cannot answer

An agent is a harness (loop, tools, skills, memory, prompting) plus a model. The
platform runs a task set under configurations and answers: did configuration A do better
than configuration B, by how much, on which tasks, and how sure are we.

**The platform measures harness plus model as a unit.** A configuration is 1 harness, 1
model and 1 set of settings. The platform can attribute a difference to 1 half only when
the experiment holds the other half fixed. "Hermes with model X vs minimal loop with
model Y" tells you which pair is better; it tells you nothing about the harness alone or
the model alone, and the comparison UI says so (it displays the axis label when the 2
configs differ on exactly 1 of harness, model or settings, and displays "multiple axes
differ: not attributable" otherwise). The primary experiment in section 10 varies exactly
1 setting (memory) and holds harness and model fixed.

Second honesty rule: **a difference is reported as noise unless the 95 percent bootstrap
confidence interval of the paired delta excludes 0** (section 9.4). The code applies this
rule; the UI never shows a bare delta without its interval and verdict.

---

## 2. Architecture

### 2.1 Components

```
docker compose up
├── db        PostgreSQL 16
├── api       NestJS (TypeScript). Control plane: registries, configs, experiments,
│             scheduler, statistics, exports, REST for the UI. Owns the database.
├── web       Vue 3 + TypeScript (Vite build served by nginx). Talks only to api.
└── worker    Python 3.14. Harness adapters (Hermes, minimal loop), the subprocess
              runner, graders (including the LLM judge). No database. Stateless
              between trials. Mounts ./tasks read-only and a /work scratch volume.
```

Keys: `.env` at the repo root, read by `api` (none needed except `DATABASE_URL`) and
`worker` (`OPENROUTER_API_KEY`). The API never holds a provider key.

### 2.2 The Python boundary, and why it sits there

Python owns everything that touches a filesystem, a subprocess or a model during
execution: harness invocation, tool side effects, fixture copying, deterministic grading
on the workspace, unit tests, the LLM judge. TypeScript owns everything that touches the
database, the queue, the statistics and the user: registries, config hashing, experiment
lifecycle, retry policy, bootstrap and kappa, exports, UI.

Reasons, in order of weight:

1. Hermes is Python 3.14 only (`pyproject.toml:10-15`). Calling it from Node would mean
   a Python subprocess anyway; making the whole execution side Python removes 1 hop and
   lets the minimal loop share the same runner, grader and model client code.
2. Grading next to execution: file-state and unit-test graders need the workspace that
   the agent just modified, in the same container, before cleanup. Shipping workspaces
   over HTTP to grade them in TypeScript would be slower and a second place to get
   isolation wrong.
3. Statistics in TypeScript: the numbers the UI shows must come from the same tested
   code the API exports; a second implementation in Python would be a consistency risk.
   Bootstrap and kappa are 200 lines of pure functions with fixed test vectors.
4. The contract between the 2 sides is 2 JSON shapes (`TrialSpec` in, `TrialResult`
   out) and 2 read-only endpoints (`GET /adapters`, `GET /health`). Adding a harness or a
   model never changes the contract.

### 2.3 Life of a trial

```
API scheduler picks a pending trial (bounded by MAX_CONCURRENT_TRIALS)
  → writes trial_attempt, sets trial.running, snapshots prices (D-7)
  → POST worker /trials/run {TrialSpec}
      worker.runner: creates /work/trials/<id>/<attempt>/{workspace,out,...}
        copies fixture (R-5), verifies task hash (R-6)
        spawns child: python -m worker.run_one spec.json  (R-1)
          child: adapter.prepare(ctx) → adapter.run(ctx) [events streamed to out/events.jsonl, H-7]
                 adapter.collect_memory(ctx) → graders run in workspace (R-7)
                 writes out/result.json
        runner enforces timeout (R-2), assembles trace from disk (R-4), deletes dir (R-8)
      ← TrialResult {outcome, usage, trace, grader_results} or {error_class, partial_trace}
  → API ingests: trial.done + trace + grader_results, or applies retry policy (6.3)
  → recomputes experiment.status (D-8)
```

### 2.4 Repository layout

```
api/            NestJS. src/{models,harnesses,tasks,configs,experiments,scheduler,stats,export,common}
web/            Vue 3. src/{views: Configs, Experiments, ExperimentDetail, Compare, Trial; api client}
worker/         Python. adapters/, runner.py, run_one.py, models.py, graders/, server.py, tests/
tasks/          <task-id>.json, fixtures/<task-id>/..., memory/<fixture>/{MEMORY.md,USER.md}, gen/ (fixture generators)
experiments/    judge-validation/labels.jsonl, results/<experiment-id>.json (committed exports)
cards/          P1..P6.md
docker-compose.yml  .env.example  README.md  DESIGN.md  ADAPTERS.md  DATA_MODEL.md  STATE.md
```

---

## 3. Adapter interfaces (summary; ADAPTERS.md is normative)

A harness adapter is a Python object with `validate(settings)`, `prepare(ctx)`,
`run(ctx)`, `collect_memory(ctx)` and a `Capabilities` declaration. It writes trace
events to a file as they happen. It never reads an API key by name and never branches on
a model id. It is registered with 1 line. It is "done" when the conformance suite, which
runs every registered adapter against a scripted stub model server, is green.

A model adapter is a row in `api/seed/models.json` (slug, base URL, key env var name,
prices, context window). The only model code path is `worker/models.py:make_client`.

Why the minimal loop as the second harness: it shares 0 lines with Hermes, so the only
thing the 2 adapters have in common is the contract; a framework adapter would have
tested how well that framework's conventions map, not whether the contract holds. The
minimal loop is also the floor against which Hermes's skills and memory are legible.
Order of construction is fixed: ADAPTERS.md frozen → Hermes adapter → minimal loop. Any
contract change forced by either is recorded in section 11.

What a third adapter writes: harness, 1 directory plus 1 registry line, conformance
suite green; model, 1 JSON object. The README repeats this with the exact file paths.

---

## 4. Data model (summary; DATA_MODEL.md is normative)

Tasks are versioned by content hash and experiments pin the hash (D-6). Configs are
immutable and content-addressed (D-3, D-5). Trials are unique per (experiment, config,
task, index) (D-12), carry a price snapshot (D-7), and are either scored (`done` with
`passed`), `errored` with a class, `cancelled` or not yet run (D-11, D-13). An experiment
cannot be `completed` while an errored trial exists (D-8). Traces are write-once and
carry messages, tool calls and results, memory reads and writes, skills invoked, grader
reasoning and the final response.

---

## 5. Configurations and versioning

A config is `harness × model × settings` where settings are: platform tools (`shell`,
`files`), memory (`off` or `seeded` with a named fixture), skills (enabled, preload
list), temperature, max_steps, max_output_tokens, timeout_seconds, and an opaque
`harness_options` map for adapter-specific knobs. The config hash covers harness id and
version, model slug and the full settings including the memory fixture's content hash.
2 configs that differ only in `name` are the same config (idempotent create).

The adapter's `validate()` runs at config creation; a config the adapter cannot honor
exactly is refused with the adapter's reasons (D-4, H-1). This is what makes "the same
settings" mean the same thing across harnesses: a harness that cannot set temperature
cannot be given a temperature.

---

## 6. Execution: isolation, reproduction, failure handling

### 6.1 Isolation

Each trial attempt gets a fresh child process (R-1), a fresh `trial_dir` with a copied
fixture (R-5), and, for Hermes, a fresh `HERMES_HOME` inside it containing only what
`prepare()` wrote (H-2). Memory content enters a trial only when the config's memory
mode is `seeded`, and then only the fixture content (H-3); the agent's memory writes land
in the trial's own directory, are captured in the trace, and are discarded with the
directory. There is no mode in which trial k's memory writes reach trial k+1. That mode
(`persistent`) was considered and rejected: it makes trials within a task dependent, which
breaks the independence the bootstrap assumes, and it makes the result depend on
scheduling order. Seeded memory answers the question the company asks ("does memory
help") without that cost. Section 13 lists what can still leak.

### 6.2 What "reproduce" means

The model is non-deterministic, so reproduction is defined on inputs, not outputs. A past
trial is reproducible when every input it ran under is recoverable by hash and can be
re-run:

| input | pinned by |
|---|---|
| config (harness id and version, model slug, all settings) | `config.config_hash`, immutable row |
| task prompt, fixture files, graders | `task.version_hash`, old versions kept |
| memory fixture content | `memory_fixture.hash`, content stored in DB |
| harness code | Hermes git commit baked into the worker image; `harness.version` |
| worker image | `experiment.worker_manifest` (image digest when available) |
| model prices | `trial.price_snapshot` |
| per-trial seed | `trial.seed`, passed to harnesses that accept a seed |
| judge model and prompt | `grader_result.judge_model_id`, `judge_prompt_hash` |

`POST /experiments/:id/reproduce` creates a new experiment pinned to the same hashes and
refuses with a list of what no longer resolves (a deleted fixture, a worker reporting a
different harness version). The platform does not claim bitwise identical outputs. What
it claims is: the same inputs, a complete record of the outputs, and a comparison whose
confidence interval accounts for the run-to-run variance.

### 6.3 Failure handling

| event | where seen | action | scored? |
|---|---|---|---|
| HTTP 429 from provider | adapter (minimal loop: backoff 1, 2, 4, 8, 16 s, 5 tries; Hermes: its own 3 retries first) | `api_call` event with `status: retry`; if exhausted → `error_class: rate_limited` | no, retried at trial level |
| HTTP 5xx, connection error, read timeout | same | same path, `provider_error` | no, retried |
| HTTP 400, 401, 403, 404, 422 | same | `config_invalid`, not retried | no, terminal |
| wall clock exceeded | runner (R-2) | `exit_reason: timeout`, `done`, `passed = false` | yes |
| max_steps reached | adapter | `exit_reason: max_steps`, `done`, `passed = false` | yes |
| malformed tool calls | adapter | `invalid_tool_call`, `done`, `passed = false` | yes |
| child exits without result | runner (R-3) | `worker_crash`, retried | no |
| grader raises | runner | `grader_error`, retried once | no |
| worker over capacity | worker returns 429 (R-9) | `backpressure`, re-queued without counting an attempt | no |
| API restarts mid-trial | scheduler at boot: `running` trials with `heartbeat_at` older than `timeout_seconds + 180` s | attempt `orphaned`, trial re-queued | no |
| cancel | API | pending → `cancelled`; running → worker `DELETE /trials/:id` best effort, then `cancelled` | no |

Trial-level retry: retryable classes re-queue with backoff 30, 60, 120 s up to
`MAX_TRIAL_ATTEMPTS = 3`; then the trial is `errored` for good. **Circuit breaker:** after
5 consecutive terminal errors across an experiment, the scheduler pauses it
(`pause_reason` set, status stays `running` with no dispatch) rather than burning the
remaining trials against a dead key; the UI offers resume. A paused or finished
experiment with any `errored` trial is `partial` (D-8), and every comparison computed on
it reports `n_excluded` and `reliability: partial`.

Rate limits and the timeout rule interact: a trial that timed out while waiting on 429
backoffs is still scored as a failure, because the platform cannot know what the agent
would have done. It is flagged with `rate_limit_events > 0` and the comparison reports how
many scored trials carry the flag, so a reader can judge whether the rate limiter, not the
agent, produced the result. Concurrency is bounded (`MAX_CONCURRENT_TRIALS`, default 2) to
keep this count low.

---

## 7. Tasks and graders

### 7.1 Principles

- A task is a prompt, an optional fixture directory copied into the workspace, and 1 or
  more graders ANDed together (D-14). The answer channel is the harness's final
  response plus the workspace.
- Final-answer tasks instruct the agent to end with a line `FINAL: <answer>`; the
  `exact_match` grader extracts the last such line and falls back to the whole final
  response. The instruction is in the task prompt, not in any harness prompt, so both
  harnesses see it.
- Deterministic wherever the ground truth is a string, a file or a test. The judge is
  used only where the output is prose.
- Every task names which axis it is designed to discriminate (`discriminates`), so the
  design intent is checkable against the result.

### 7.2 The task set (22 tasks)

Memory fixture `team-memory-v1` (`tasks/memory/team-memory-v1/`): `MEMORY.md` under 2,000
characters with 8 team facts (staging DB host and port, service owners, cron timezone,
standard `config.json`, the lint command with `--strict`, the 4-step release checklist,
the meaning of status values in data files, report naming); `USER.md` under 1,200
characters (name, terse answers, a stated YAML preference used as a distractor, timezone).
The limits follow Hermes's `memory_char_limit` 2200 and `user_char_limit` 1375.

| id | category | prompt gist | graders | expected | discriminates |
|---|---|---|---|---|---|
| mem-01-staging-db | memory_dependent | staging DB host and port, `FINAL: host:port` | exact_match | `pg-stage-07.internal:6432` | memory |
| mem-02-owner | memory_dependent | who owns the ingest service | exact_match | `Marco` | memory |
| mem-03-config | memory_dependent | create `config.json` per team standard | file_state (json: log_level WARN, port 8443, metrics true) | | memory |
| mem-04-cron-tz | memory_dependent | IANA timezone for nightly cron | exact_match | `Europe/Amsterdam` | memory |
| mem-05-lint | memory_dependent | run the project lint "the way we do it", report PASS/FAIL; fixture `lint.py` prints FAIL and exits 1 only with `--strict` | exact_match `FAIL` + trace_check (shell args match `--strict`) | | memory |
| mem-06-release | memory_dependent | write `RELEASE.md` with our release checklist | llm_judge (4 criteria: bump VERSION, lint --strict, tag vX.Y.Z, post in #releases) | | memory |
| dis-01-json | memory_distractor | create `service.config` as JSON with log_level INFO, port 9000 (USER.md prefers YAML) | file_state (valid JSON, values) | | memory (should not hurt) |
| dis-02-owners-file | memory_distractor | owner of billing per `OWNERS.txt` in workspace (memory says Priya, file says Sam) | exact_match | `Sam` | memory (should not hurt) |
| det-01-csv-count | neutral_deterministic | count rows in `data.csv` with status `failed` | exact_match | generated, committed | model |
| det-02-hello | neutral_deterministic | write `hello.py` printing `hello, evals` | unit_test (runs it, compares stdout) | | none |
| det-03-slugify | neutral_deterministic | implement `slugify` in `slug.py` per spec | unit_test (8 hidden cases) | | model |
| det-04-median | neutral_deterministic | fix even-length bug in `stats.py` median | unit_test | | model |
| det-05-rename | neutral_deterministic | rename `data/*.txt` to `.md`, contents unchanged | file_state | | none |
| det-06-ini | neutral_deterministic | value of `[server] port` in `config.ini` | exact_match | `8081` | none |
| det-07-sort | neutral_deterministic | numeric sort of `numbers.txt` (has negatives) into `sorted.txt` | file_state (equals generated) | | model |
| det-08-revenue | neutral_deterministic | total revenue of completed orders in `orders.json`, 2 decimals | exact_match | generated | model |
| jdg-01-summary | neutral_judged | ≤5 bullet summary of `NOTES.md` incident | llm_judge (root cause named, fix named, ≤5 bullets, no invented facts) | | model |
| jdg-02-commit | neutral_judged | commit message for `diff.patch` | llm_judge (subject ≤72 chars, imperative, names the pagination off-by-one, body says why) | | model |
| jdg-03-docstring | neutral_judged | docstring for `parse_duration` in `util.py` | llm_judge (args, return, ValueError case, example) | | model |
| jdg-04-flaky | neutral_judged | why `test_flaky.py` is flaky | llm_judge (identifies unseeded `random.sample`, proposes seed or fixture) | | model |
| hon-01-missing-key | honesty | value of `api_timeout` in `settings.toml`, or `NOT_FOUND`; key absent | exact_match | `NOT_FOUND` | model, harness |
| hon-02-missing-fn | honesty | return of `compute_tax(100)` in `tax.py`, or `NOT_FOUND`; only `compute_vat` exists | exact_match | `NOT_FOUND` | model, harness |

Grader mix: exact_match 10, file_state 4, unit_test 3, trace_check 1 (combined),
llm_judge 5. Fixtures with computed answers (`det-01`, `det-07`, `det-08`) are produced by
`tasks/gen/*.py` with a fixed seed and committed together with the expected value, so the
expected value is derived, never typed by hand.

Why these discriminate: the 6 memory-dependent tasks are unanswerable from the workspace;
a memory-off agent must guess or admit ignorance, and 4 of the 6 have a single exact
answer no guess will hit. `mem-05` is the strongest: the correct behaviour (adding
`--strict`) is invisible without memory and the trace check proves the mechanism, not
just the answer. The 2 distractor tasks catch the failure mode where memory hurts (stale
or preference content overriding explicit instructions). The 14 neutral and honesty tasks
are expected to show no memory effect; they are the noise floor and the control.

### 7.3 Grader specifications

```jsonc
{"type":"exact_match", "expected":"Marco" | ["a","b"], "expected_regex":null,
 "normalize":["trim","lowercase","collapse_whitespace"], "extract":"final_line"}
   // extract final_line: last line matching ^FINAL:\s*(.+)$ ; fallback: whole response
{"type":"file_state", "checks":[
   {"path":"config.json","exists":true},
   {"path":"config.json","json_path":"$.port","equals":8443},
   {"path":"sorted.txt","equals_file":"expected/sorted.txt"},
   {"path":"data/a.txt","exists":false}]}
{"type":"unit_test", "hidden_files":["tests/test_slug.py"], "command":"python -m pytest -q tests/test_slug.py",
 "timeout_seconds":60}      // hidden files copied in after run() (R-7); pass iff exit 0
{"type":"trace_check", "assertions":[
   {"kind":"tool_called","tool":"shell","args_regex":"--strict"},
   {"kind":"tool_not_called","tool":"shell"},
   {"kind":"max_steps","value":10}]}
{"type":"llm_judge", "rubric":[{"id":"c1","criterion":"..."},...], "pass_rule":"all",
 "inputs":["final_response","workspace_file:RELEASE.md"], "judge_model_id":null /* default JUDGE_MODEL_ID */}
```

### 7.4 Adding a task (README section, repeated here)

1. Create `tasks/<id>.json` with the schema above and, if needed, `tasks/fixtures/<id>/`.
2. If the answer is computed, add a generator under `tasks/gen/` and commit its output.
3. `docker compose exec api npm run tasks:sync` (also runs at startup). The task appears
   with a new `version_hash`; existing experiments are unaffected (D-6).
4. `npm run tasks:lint` validates the JSON against the schema and checks every fixture
   path exists.

---

## 8. Judge design and validation

### 8.1 Design

- Judge model: a registry row with role `judge`, selected by `JUDGE_MODEL_ID`. In the
  primary experiment the candidate configs use the cheaper model and the judge is the
  other one, so the judge never grades its own outputs.
- Prompt: `worker/graders/judge_prompt_v1.txt`, versioned by hash
  (`grader_result.judge_prompt_hash`). The judge receives the task prompt, the rubric
  criteria, and only the declared `inputs` (final response and named workspace files),
  never the trajectory. Reason: judging the trajectory rewards verbosity and tool
  theatre; the rubric is about the output. Mechanism questions use `trace_check`.
- Output: strict JSON `{"criteria":[{"id","met","evidence"}],"pass":bool,"reasoning"}`
  at temperature 0. `pass` is recomputed by the grader from `criteria` under `pass_rule`
  (the model's own `pass` is stored but not trusted). Parse failure → 1 retry → `grader_error`.
- The judge's reasoning is stored verbatim on the grader result and shown in the trial
  inspector, so a disagreement is debuggable.

### 8.2 Validation protocol (fixed before labelling)

1. Label taxonomy: binary `PASS`/`FAIL` per judge grader, defined by the rubric text,
   which is frozen before any trial runs. The labeler applies the rubric literally;
   "would I have accepted it" is not the question.
2. Sample: 30 judge-graded trials, stratified 6 per judge task (3 per config), drawn by
   `npm run judge:sample` from the pilot and full runs, exported blind (D-15).
3. Labelling: 1 labeler (the author), seeing task prompt, rubric, final response and the
   named workspace file. Labels go in `experiments/judge-validation/labels.jsonl`.
4. `npm run judge:kappa` joins labels with judge verdicts and computes raw agreement,
   Cohen's kappa, and a 95 percent bootstrap CI over items (same bootstrap code as
   section 9), writing a `judge_validation` row.

### 8.3 Thresholds and what they mean

| κ | policy | effect in the code |
|---|---|---|
| ≥ 0.6 | `trusted` | judge tasks count in the headline comparison |
| 0.4 ≤ κ < 0.6 | `flagged` | judge tasks count, every comparison carries `judge_confidence: low` and the UI shows a badge |
| < 0.4, or no validation row | `excluded` | judge tasks are removed from the headline comparison and shown in a separate table; the rubric is marked broken |

Below 0.4 the problem is the taxonomy or the rubric, not the raters: a rubric that 2
careful readers apply differently is not a measurement instrument. In that case the
assignment's own guidance applies: fall back to deterministic graders (the 17
deterministic tasks remain) and rewrite the rubric before trusting any judged number.

Single-rater limit: with 1 labeler there is no human-human kappa to use as a ceiling. If
the labeler's own agreement with the rubric is low, the labelled set is not ground truth
and every number computed against it is noise. The design records this (section 13) and
the labels file carries a `labeler` field so a second rater can be added without schema
change.

### 8.4 How the policy reaches the numbers

The comparison endpoint loads the latest `judge_validation` row for the judge model and
prompt hash in use and applies the policy before computing anything. A comparison
payload always states `judge_policy_applied` and the list of tasks excluded by it.

---

## 9. Statistical method

### 9.1 Data shape

T tasks, C configs, N trials per (task, config). Each trial yields `passed ∈ {0,1}` plus
cost, latency and tokens. Per (task, config) the pass rate `p_tc = mean(passed)`. The
primary metric of a config is the macro average `P_c = mean_t(p_tc)`: every task weighs
the same regardless of how many graders it has.

### 9.2 Why a paired bootstrap over tasks

The quantity of interest for A vs B is `Δ = mean_t(p_tA − p_tB)`. Pairing is by task: the
same task is run under both configs, so task difficulty cancels. Because N trials give a
pass *rate* per task, the per-task delta is continuous on [−1, 1], not binary. McNemar
needs 1 binary outcome per pair and would discard the trial-level information (or force
an arbitrary pairing of trial i under A with trial i under B). The bootstrap makes no
distributional assumption, handles T = 22 small-sample clustered data, and the same
function serves cost, latency, tokens and kappa.

### 9.3 Procedure

```
inputs: dA[t], dB[t] = per-task pass rates (only status = done trials), t = 1..T
Δ_obs = mean_t(dA[t] − dB[t])
for r in 1..R (R = 10,000):
    draw T task indices with replacement (seeded PRNG, seed stored on comparison_run)
    Δ_r = mean over drawn tasks of (dA − dB)
CI = [percentile 2.5 of Δ_r, percentile 97.5 of Δ_r]
```

Resampling tasks (clusters) rather than trials is deliberate: trials within a task are
exchangeable but tasks are not, and the question is about the task population. The
within-task sampling noise is already inside each `d[t]`.

Per-category deltas (memory_dependent, memory_distractor, neutral, honesty) are computed
with the same procedure restricted to the category's tasks, because the hypothesis in
section 10 is stated per category.

### 9.4 The noise rule

`verdict = "noise"` iff `CI_low ≤ 0 ≤ CI_high`; else `"A_better"` or `"B_better"` by the
sign of `Δ_obs`. The payload also reports `min_detectable = (CI_high − CI_low) / 2` so a
reader sees what size of effect this experiment could have found. The rule is applied in
`api/src/stats/compare.ts` and tested with fixed inputs on both sides of the boundary.

### 9.5 Secondary tests and per-task deltas

- Sign test over tasks: count tasks with `d_A > d_B` vs `d_A < d_B`, exact binomial
  p-value, ties dropped. Distribution-free and legible: "A won on 9 tasks, B on 2, 11 tied".
- McNemar: computed only when N = 1 (then each task is 1 binary pair), with exact
  binomial p on the discordant pairs; otherwise omitted and the payload says why.
- Per-task table: `d_A, d_B, delta`, and a per-task bootstrap CI resampling trials within
  the task (N vs N). At N = 5 these intervals are wide; the table labels them "direction
  only" and no multiple-comparison correction is applied, because the per-task view is
  diagnostic, not inferential. The headline is the aggregate and the per-category delta.
- Cost, latency, tokens: per config, mean of per-task means, with the same task-level
  bootstrap CI, shown next to the quality number so the trade-off is 1 table.

### 9.6 Comparison payload

```jsonc
{"experiment_id","config_a","config_b","axis","n_tasks","n_trials_per_task","n_scored","n_excluded",
 "reliability":"complete"|"partial","rate_limit_affected_trials":int,
 "judge_policy_applied","judge_excluded_tasks":[],
 "aggregate":{"p_a","p_b","delta","ci_low","ci_high","verdict","min_detectable","resamples","seed"},
 "by_category":{"memory_dependent":{...same...},...},
 "sign_test":{"a_wins","b_wins","ties","p_value"},
 "mcnemar":null|{...},
 "per_task":[{"task_id","category","n_a","n_b","rate_a","rate_b","delta","ci_low","ci_high","verdict"}],
 "cost":{"a":{"mean","ci_low","ci_high"},"b":{...},"delta_ci":[..]},
 "latency_ms":{...},"tokens":{"input":{...},"output":{...}},
 "stats_version"}
```

### 9.7 How N was chosen

The within-task sampling noise of a pass rate from N Bernoulli trials has variance at
most `σ² = 0.25` (at p = 0.5). The paired delta over T tasks then has standard error at
most `sqrt(2σ² / (N·T))`, and a 95 percent interval half-width `h(N) ≈ 1.96 · sqrt(2σ² / (N·T))`.
With T = 22 and σ² = 0.25:

| N | h(N) | trials for 2 configs |
|---|---|---|
| 3 | 0.171 | 132 |
| 5 | 0.132 | 220 |
| 8 | 0.104 | 352 |
| 10 | 0.093 | 440 |

The smallest aggregate change worth acting on for a harness or model swap is taken as
0.15 absolute (a 15 point move on a 22-task set; smaller moves are within what task-set
churn alone produces). N = 5 is the knee: it brings the bound under 0.15, and N = 8 buys
0.03 for 60 percent more cost. This bound ignores between-task heterogeneity, which the
task-level bootstrap captures and which N does not reduce; that is why the pilot
measures the real variance rather than trusting the bound.

**Pilot (required, P5):** run both configs at N = 3. Compute the observed within-task
variance `s² = mean over (task, config) of p̂(1 − p̂) · N/(N − 1)` and the projected
`h(N)` for N ∈ {3, 5, 8}. Decision rule, applied by `GET /experiments/:id/pilot`: choose
the smallest N with `h(N) ≤ 0.15`, capped at 8 by budget. **The pilot endpoint returns
variances and projected widths only; it does not return the delta**, so N is chosen
without looking at the answer. The full run extends the same experiment (D-9), reusing
the 3 pilot trials.

Pre-registered expectation for the primary experiment (section 10): on the 6
memory-dependent tasks `h(5) ≈ 1.96 · sqrt(0.5 / 30) = 0.253` with an expected delta
around 0.5, so a real effect is detectable there; on the aggregate the expected delta is
about `6/22 × 0.5 ≈ 0.14`, inside `h(5) = 0.132` to `0.17`. The honest prediction is
therefore: the memory-dependent category shows a non-noise effect, the aggregate may be
declared noise at N = 5, and the neutral category is noise. If the aggregate comes out
"noise", that is the method working.

---

## 10. The experiment

### 10.1 Axis and hypothesis (pre-registered; immutable once the experiment leaves draft, D-10)

Axis: Hermes Agent, 1 fixed model (the cheaper of the 2 registry rows, named in STATE.md
after P1 verifies slugs), identical settings (`tools: [shell, files]`, skills off,
temperature 0, max_steps 15, max_output_tokens 2048, timeout 300 s), **memory `off` vs
memory `seeded` with `team-memory-v1`**.

H1: on `memory_dependent` tasks, the seeded config's pass rate exceeds the off config's
by at least 0.5 absolute, CI excluding 0.
H2: on `memory_distractor`, `neutral_*` and `honesty` tasks, the delta's CI contains 0
(memory does not hurt, and does not help where it should not).
H3 (cost): the seeded config uses more input tokens per trial, by roughly 800 tokens per
API call (the fixture is about 2,000 characters; Hermes's own comment estimates 2.75
characters per token, `config_defaults.py:1334`), so cost per trial rises in proportion to
steps. This is the trade-off the comparison table makes visible.

### 10.2 Setup

T = 22, pilot N = 3, then N per the pilot rule (expected 5). Concurrency 2. Judge = the
other registry model. Judge validation (section 8) runs on 30 trials drawn after the
full run.

### 10.3 Secondary experiment (run if budget allows)

Same Hermes settings with memory off, model A vs model B. Specced and runnable from the
same UI; not required for the deliverable.

### 10.4 Results

`TBD by P5`: pilot variance and chosen N; aggregate and per-category deltas with CIs;
per-task table; cost, latency and token table; judge kappa; 2 or 3 inspected trajectories
(1 memory-dependent pass under seeded vs fail under off, 1 distractor trial, 1 failure
where memory was present but unused or misused); conclusion stated against H1 to H3;
actual spend.

---

## 11. Contract findings

`TBD by P2`: every change ADAPTERS.md needed while implementing the Hermes adapter and
then the minimal loop, with the reason. An empty list is a valid finding and should be
stated as such. Known candidates to check: whether `steps` (H-9) can be derived from
Hermes callbacks exactly; whether the system prompt is capturable (A-6).

---

## 12. Cost

### 12.1 Formula

```
cost(experiment) = Σ over configs c of  T × N × ( tok_in(c) × price_in(c) + tok_out(c) × price_out(c) ) / 1e6
                 + judge:  T_judged × N × C × ( tok_in(judge) × price_in(judge) + tok_out(judge) × price_out(judge) ) / 1e6
tok_in(c) = average input tokens per trial = steps(c) × average prompt size per call
```

Hermes's prompt size per call is dominated by its system prompt and the growing
conversation; the memory fixture adds about 800 tokens to every call of the seeded
config. The platform computes every term from recorded trials, so after the pilot the
formula has measured inputs rather than guesses.

### 12.2 Estimate (placeholders until P1 fills prices and P5 fills measurements)

ASSUMPTION A-10: an average Hermes trial on this task set makes about 6 model calls with
about 6,000 input tokens per call and 300 output tokens per call, giving about 36,000
input and 1,800 output tokens per trial. With T = 22, N = 5, C = 2: 7.9 M input and 0.4 M
output tokens. At placeholder prices of 0.50 USD per M input and 2.00 USD per M output
that is about 4.75 USD for the candidate runs; the judge adds 5 tasks × 5 trials × 2
configs = 50 calls of about 2,000 tokens, under 0.20 USD at the same prices. The pilot
costs 3/5 of that and is reused. Actual spend is reported in section 10.4.

### 12.3 Reducing it

- Caching: prompt caching on providers that support it (the memory fixture and Hermes
  system prompt are identical across calls; `cache_read_tokens` is already recorded so
  the saving is measurable). Response caching across trials is deliberately not done:
  it would collapse the variance the experiment measures.
- Early stopping: after the pilot, a config pair whose per-category CI already excludes 0
  by a wide margin can stop extending; the pilot endpoint's projected widths support that
  decision without revealing the delta direction. Per-trial: `max_steps` and
  `timeout_seconds` bound the worst case.
- Sampling: for a quick regression check, run only the tasks whose `discriminates`
  includes the axis under test (6 of 22 for memory), accepting the wider CI and saying so.
- Cheaper judge: the judge sees only the output, not the trajectory, which keeps its
  calls short by construction.

---

## 13. Known limits

Where the platform's conclusions should not be trusted, and why.

1. **Task-set size.** 22 tasks, 6 of them on the memory axis. The aggregate CI at N = 5
   is about ±0.13; effects below that are invisible. Per-task CIs are direction only. A
   conclusion about "memory" rests on 6 hand-written tasks and generalizes only to tasks
   like them.
2. **Judge bias.** 1 judge model, 1 prompt, 1 human labeler, 30 labelled items. Kappa's
   CI at n = 30 is wide. The judge never sees the trajectory, which removes length bias on
   the process but means it cannot penalize a right answer reached by a wrong method. If
   the secondary experiment compares models, the judge may be 1 of them (self-preference
   bias); the payload names the judge model so the reader can see this.
3. **Contamination.** Deterministic tasks (`slugify`, median, CSV counting) are the kind
   of thing models have seen many times; they measure competence at familiar work, not
   generalization. Memory tasks use invented facts, so they cannot be contaminated, which
   is part of why they discriminate.
4. **Isolation leak channels, by name.** (a) Anything Hermes writes outside
   `HERMES_HOME` and the workspace: the conformance test watches `/tmp` and a read-only
   `HOME`, but only for the paths it watches. (b) Shared provider rate-limit state across
   concurrent trials (`MAX_CONCURRENT_TRIALS` = 2): a 429 storm during config A's trials
   and not B's biases latency and timeout counts toward A; `rate_limit_events` per trial
   makes this visible, not absent. (c) Hermes's `state.db` under `HERMES_HOME` is fresh per
   trial, but any global caches Hermes keeps in the package directory (`/opt/hermes-agent`)
   would persist across trials in the same worker container; the P1 builder lists what the
   package directory contains after a run and records it in STATE.md. (d) The clock: Hermes
   injects the current date into its system prompt (`system_prompt.py:495-519`); 2 trials
   on different days have different prompts. The date is in the captured system prompt
   when A-6 holds. (e) The provider: model weights, routing and rate limits behind an
   OpenRouter slug can change between runs; the slug is pinned, the backend is not.
5. **Harness-specific quirks.** Hermes performs its own retries, auxiliary LLM calls
   (titles, compression) that may or may not be counted in its token totals (A-7), has no
   seed parameter, and sets temperature only through `request_overrides`. The minimal loop
   has none of these, so "Hermes vs minimal loop" compares behaviours the platform cannot
   fully equalize; the comparison axis label says "harness" and the reader should expect
   these confounds.
6. **No sandbox.** The agent's shell runs in the worker container with the workspace as
   cwd. Host side effects are limited to the container, not prevented. A task that asks
   for network access would succeed or fail based on the container's network, which the
   platform does not control or record.
7. **Single run, single day.** The experiment is 1 run on 1 day against 1 provider
   backend. Reproduction (section 6.2) re-runs the inputs; it cannot re-run the backend.
8. **Pre-registration is procedural, not cryptographic.** D-10 stops edits through the
   API; it does not stop a direct database edit. The committed export in `experiments/`
   with its git history is the audit trail.

---

## 14. Assumptions register

Every assumption carries an id; the builder who verifies it records the outcome in
STATE.md. A-1 to A-9 are defined in ADAPTERS.md; A-10 in section 12.2.

| id | assumption | verified by | default if false |
|---|---|---|---|
| A-1 | Hermes editable install succeeds on `python:3.14-slim` | P1 | add build tools; drop `nemo-relay` |
| A-2 | Hermes top-level modules importable after install | P1 | set `PYTHONPATH` |
| A-3 | `config.yaml` key nesting as written | P1 | adjust from `cli-config.yaml.example` |
| A-4 | programmatic `AIAgent` does not sync skills | P2 | call sync explicitly |
| A-5 | exact `turn_exit_reason` string for the iteration cap | P1 | pin whatever the code says |
| A-6 | system message present in `result["messages"]` | P1 | `system_prompt_capture = False` |
| A-7 | auxiliary call tokens included in session totals | P1 | note in limits; cost under-reported for Hermes |
| A-8 | OpenRouter forwards `seed` | P2 | `seed` unused; capability false |
| A-9 | OpenRouter models endpoint shape | P1 | fill prices by hand from the provider page, cite the URL and date |
| A-10 | token volume per trial | P5 | replaced by measurement |
| A-11 | Hermes `provider="openrouter"` with explicit `base_url` and `api_key` uses them directly (`agent_init.py:993-996`) | P1 | `provider="custom"` |
| A-12 | `HERMES_YOLO_MODE=1` prevents every approval prompt for `local` terminal | P1 | `approvals.mode: off` in config.yaml is also written; if a prompt still blocks, disable the `terminal` toolset for that run and record |
| A-13 | Hermes honors `run_budget_seconds` by returning a result rather than raising | P1 | runner timeout covers it (R-2) |

---

## 15. Deliverables map and phase plan

| deliverable | where |
|---|---|
| source, tests, README (setup, add a task, add a harness, add a model) | repo root; README written in P5 from sections 3, 7.4 and ADAPTERS.md 5 |
| design document | this file |
| known limits | section 13 |
| cost estimate | section 12 |
| 1 real experiment | section 10, export under `experiments/results/` |
| video | script in P5, recorded by the author |

| phase | ships | cuttable? |
|---|---|---|
| P1 | compose, schema, registries, worker runner, Hermes adapter, exact_match and file_state graders, 1 trial end to end via API | no |
| P2 | minimal loop against the frozen contract, remaining graders, full 22-task set, judge tooling, section 11 | no |
| P3 | experiments, scheduler, retries, statuses, stats module, compare and export endpoints, pilot endpoint | no |
| P4 | Vue UI: configs, experiments, compare, trial inspector | needed for the video; API and CLI exports stand alone before it |
| P5 | pilot, N decision, full run, judge validation, results, README, video script | no |
| P6 | failure categorization | yes, stretch |

After P3 the submission is coherent: everything is runnable and exportable from the API.
