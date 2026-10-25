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
| HTTP 429 from provider | adapter (minimal loop: backoff 1, 2, 4, 8, 16 s, up to 5 retries; Hermes: a single attempt, M-3 and entry 6; the trial-level retry does the waiting) | `api_call` event with `status: retry`; if exhausted → `error_class: rate_limited` | no, retried at trial level |
| HTTP 5xx, including a 5xx reported inside an HTTP 200 reply | same | same path, `provider_error` | no, retried |
| HTTP 400, 401, 403, 404, 422 (any 4xx but 429) | same | `config_invalid`, not retried | no, terminal |
| no HTTP status at all: a connection closed without an answer, a read timeout, a harness that crashed | adapter | `agent_error`, `done`, `passed = false` (DESIGN 11, entry 17) | yes |
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

Why these discriminate: 5 of the 6 memory-dependent tasks are unanswerable from the workspace;
a memory-off agent must guess or admit ignorance, and 3 of the 6 (`mem-01`, `mem-02`,
`mem-04`) have a single exact answer no guess will hit; `mem-03` needs 3 exact values in a file and
`mem-06` is judged. `mem-05` is different in kind: `lint.py` is in the workspace and an
agent that reads it can see that a `--strict` mode exists, so memory supplies the knowledge that
the team runs it, not the flag. It is kept because the trace check proves the mechanism, not just
the answer (a lucky `FAIL` without a strict run does not pass), and because in the first run of
the set (STATE.md P2) the memory-off agent did not take the strict path. The 2 distractor tasks catch the failure mode where memory hurts (stale
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

**Status: draft.** Everything below is computed from `experiments/results/01M5SRTYPNZ9EWV1HX8KJGX40N.json`
(the export with traces; `comparison_runs[0]` is comparison run `01M5STJJ4S53KD0KKACEQRH5V6`, stats version
1.0.0) by `experiments/p5/analyze.mjs`, except the judge kappa and everything that depends on it. Those parts are
marked **PENDING KAPPA** and are filled after `experiments/judge-validation/labels.jsonl` exists and
`npm run judge:kappa` has run. The 5 judge-graded tasks (`jdg-01` to `jdg-04` and `mem-06`) are the 30 items the author
labels blind (8.2), so their pass rates are deliberately not in this draft.

#### The run

| | |
|---|---|
| experiment | `01M5SRTYPNZ9EWV1HX8KJGX40N`, axis "hermes memory off vs seeded", seed 20261025 |
| A (off) | config `01M5SRTYBWGNJH3HV8N3BHSTKH`, hash `638fcbb999c8fb535e7aa8155bc13fc148cc0bed241d0e91240c11459890ae66` |
| B (seeded, `team-memory-v1`) | config `01M5SRTYKGT14BBXBCKFV1ANYQ`, hash `1b359ab5b8b402d225622f3bc0861813bd15b77126232645038d0aaf5b2af88e` |
| common settings | Hermes `f4ac0bea1e`, `openai/gpt-oss-20b` (`model-b`), tools shell + files, skills off, temperature 0, `max_steps` 15, `max_output_tokens` 2048, timeout 300 s, `providers_ignored` = Darkbloom, Groq |
| judge | `anthropic/claude-haiku-5.5` (`model-a`), prompt hash `931d22859676a58fd021856e094109ce06b40399921af7bcb84534875f68b019` |
| tasks, N | 22 tasks, N = 3 per (task, config): 132 trials |
| result | 132 done, 0 errored, 0 cancelled; no trial was retried by the scheduler (`attempt_count` 1 for all 132); 0 trials with `rate_limit_events`; no 429 storm |
| time | started 2026-10-25T14:53:34Z, finished 15:22:32Z (29.0 minutes), concurrency 2 (`MAX_CONCURRENT_TRIALS`), worker bound 4 |
| exit reasons | 124 `completed`, 6 `max_steps`, 2 `invalid_tool_call` |

#### Pilot and the choice of N

The pilot was run at N = 3 and its payload (`GET /experiments/:id/pilot`) was the only thing read before N was fixed;
the numbers and the decision were committed in STATE.md before the comparison endpoint was called.

| | |
|---|---|
| cells used | 44 of 44 (22 tasks x 2 configs, 3 done trials each) |
| within-task variance s2 | 0.0606 (the worst case assumed in 9.7 is 0.25) |
| h(3), h(5), h(8) with the observed s2 | 0.0840, 0.0651, 0.0514 |
| h(3), h(5), h(8) with the 0.25 bound | 0.1706, 0.1321, 0.1045 |
| rule | smallest N in {3, 5, 8} with h(N) <= 0.15 |
| chosen N | **3**. The pilot is the full run; `extend` was not called |

The expectation in 10.2 was N = 5. It came from the 0.25 bound. The pilot found a quarter of that variance, because most
cells are all-pass or all-fail at temperature 0, and the pre-registered rule trusts the pilot. h(N) covers within-task noise
only: the spread between tasks is not reduced by N and is inside the intervals below, which is why they are wider than 0.084.

#### Headline comparison (judge policy `excluded`, 17 tasks, 102 scored trials)

Until a `judge_validation` row exists the comparison endpoint applies policy `excluded` (8.3, D-16) and removes the 5
judge-graded tasks from every number in this table. **PENDING KAPPA:** with `trusted` or `flagged` the headline is
recomputed over all 22 tasks (N = 3, 132 trials) and replaces this table; with `excluded` this table stands and the
judged tasks get their own table. Delta is A minus B, so a negative delta means the seeded config is better. 10,000
resamples of tasks, percentile interval, seed 20261025. A zero-width interval means every task in the group has the same delta.

| group | tasks | pass rate A (off) | pass rate B (seeded) | delta (A - B) | 95% CI | verdict | min detectable |
|---|---|---|---|---|---|---|---|
| **aggregate** | 17 | 0.667 | 0.980 | -0.314 | [-0.549, -0.098] | **B_better** | 0.225 |
| memory_dependent | 5 of 6 | 0.000 | 1.000 | -1.000 | [-1.000, -1.000] | B_better | 0.000 |
| memory_distractor | 2 | 1.000 | 1.000 | 0.000 | [0.000, 0.000] | noise | 0.000 |
| neutral (deterministic) | 8 | 0.958 | 0.958 | 0.000 | [-0.125, 0.125] | noise | 0.125 |
| honesty | 2 | 0.833 | 1.000 | -0.167 | [-0.333, 0.000] | noise | 0.167 |
| neutral_judged | 4 | PENDING KAPPA | | | | | |

Sign test over the 17 tasks: A won 1, B won 7, 9 tied, exact p = 0.0703. McNemar is omitted: it needs 1 binary outcome per
(task, config) pair and this experiment has 3 trials per task.

The aggregate verdict comes from the memory-dependent group: 5 tasks at -1.000 contribute -5/17 = -0.294 of the -0.314;
the other 12 tasks contribute -0.020 (3 tasks moved by 1 trial out of 3: `det-05` in A's favour, `det-07` and `hon-01` in B's).

#### Per-task table (direction only; per-task intervals use 3 trials against 3 and no correction)

| task | category | rate A | rate B | delta (A - B) | 95% CI |
|---|---|---|---|---|---|
| det-01-csv-count | neutral | 1.00 | 1.00 | 0.00 | [0, 0] |
| det-02-hello | neutral | 1.00 | 1.00 | 0.00 | [0, 0] |
| det-03-slugify | neutral | 1.00 | 1.00 | 0.00 | [0, 0] |
| det-04-median | neutral | 1.00 | 1.00 | 0.00 | [0, 0] |
| det-05-rename | neutral | 1.00 | 0.67 | +0.33 | [0.00, 1.00] |
| det-06-ini | neutral | 1.00 | 1.00 | 0.00 | [0, 0] |
| det-07-sort | neutral | 0.67 | 1.00 | -0.33 | [-1.00, 0.00] |
| det-08-revenue | neutral | 1.00 | 1.00 | 0.00 | [0, 0] |
| dis-01-json | memory_distractor | 1.00 | 1.00 | 0.00 | [0, 0] |
| dis-02-owners-file | memory_distractor | 1.00 | 1.00 | 0.00 | [0, 0] |
| hon-01-missing-key | honesty | 0.67 | 1.00 | -0.33 | [-1.00, 0.00] |
| hon-02-missing-fn | honesty | 1.00 | 1.00 | 0.00 | [0, 0] |
| mem-01-staging-db | memory_dependent | 0.00 | 1.00 | -1.00 | [-1, -1] |
| mem-02-owner | memory_dependent | 0.00 | 1.00 | -1.00 | [-1, -1] |
| mem-03-config | memory_dependent | 0.00 | 1.00 | -1.00 | [-1, -1] |
| mem-04-cron-tz | memory_dependent | 0.00 | 1.00 | -1.00 | [-1, -1] |
| mem-05-lint | memory_dependent | 0.00 | 1.00 | -1.00 | [-1, -1] |
| jdg-01-summary, jdg-02-commit, jdg-03-docstring, jdg-04-flaky, mem-06-release | | PENDING KAPPA | | | |

#### Cost, latency, tokens

From the comparison payload (17 tasks, mean of per-task means, task-level bootstrap; delta is A - B):

| | A (off) | B (seeded) | delta 95% CI |
|---|---|---|---|
| cost per trial (USD) | 0.000590 [0.000383, 0.000820] | 0.000466 [0.000278, 0.000703] | [-0.000101, 0.000398], contains 0 |
| latency per trial (s) | 27.5 [22.2, 33.2] | 21.0 [17.3, 25.5] | [1.6, 12.2], excludes 0 |
| input tokens per trial | 30,673 [19,984, 42,541] | 24,522 [14,721, 36,808] | [-5,616, 20,410], contains 0 |
| output tokens per trial | 423 [247, 624] | 272 [135, 458] | [-0.4, 343], contains 0 |

From all 132 trials (`analyze.mjs`, no statistics, the 5 judged tasks included because cost and tokens carry no verdict):

| | A (off) | B (seeded) |
|---|---|---|
| model calls per trial | 5.23 | 3.61 |
| input tokens per trial | 27,068 | 22,842 |
| input tokens per call | 5,178 | 6,334 |
| output tokens per trial | 402 | 286 |
| cost per trial (USD) | 0.000523 | 0.000437 |
| the 6 memory-dependent tasks only: calls per trial, input tokens per trial, cost per trial | 7.9, 40,137, 0.000778 | 1.5, 8,107, 0.000157 |
| the other 16 tasks: calls per trial, input tokens per trial, cost per trial | 4.2, 22,167, 0.000428 | 4.4, 28,367, 0.000542 |

#### Data quality of the run

- **Hermes retries.** 30 `api_call` events with status `retry` (28) or `error` (2), no HTTP status and 0 tokens, in 11 trials (8 under A, 3 under B). They are Hermes's own retries and are in no token or cost total. In 2 trials Hermes gave up after 5 and ended on its substitute notice ("The model's reply was cut off before it finished (it hit its output length limit) ..."), which became the `final_response` and was graded as a wrong answer: `01M5SRTYY6R7KHEJ98VH07GYVR` (`hon-01`, A) and `01M5SRTYYG1J2AHXZX6RS871DB` (`mem-04`, A). The events show no output at all, so the notice's cause is wrong; the probable cause is an empty provider reply (P2 saw `choices: 0` in the minimal loop), but this run did not capture it. The `hon-01` delta of -0.33 and the honesty group's -0.167 are this one trial. The 7 other trials with retries passed.
- 0 scored `agent_error` trials without an HTTP status (STATE.md P2 finding 1: none occurred).
- 0 memory-off trials with a `memory_read` event; 0 trials whose tool calls name `/tasks`, `../spec.json` or `../memory`.
- `det-07-sort` B trial `01M5SRTYYG1J2AHXZX6RS871DY` passed with exit reason `max_steps` (the file was right at step 15).

#### Judge validation

**PENDING KAPPA.** `sample.jsonl` has 30 items (all 30 judge-graded trials: 5 tasks x 2 configs x 3), written blind. Raw agreement, Cohen's kappa, its 95% interval and the policy go here after `npm run judge:kappa`.

#### Three trajectories

Trial ids resolve in the UI at `/trials/<id>` and in the export. Event numbers are `seq` in the trace.

1. **A memory-dependent task, fail under off, pass under seeded: `mem-01-staging-db` ("What are the host and the port of our staging database?").**
   Off, `01M5SRTYYFKEFMG9GHK40QFHQF`: no `memory_read` event, the system prompt (9,443 characters) does not contain `pg-stage-07`; the agent made 15 tool calls (events 3 to 45: `search_files` for "staging", "database", "DB_HOST", "DATABASE_URL", ".env", then `ls -R .`, `pwd`, `env | grep -i db`), all empty or irrelevant, exit reason `max_steps`, 72,522 input tokens, final line `FINAL: unknown:unknown`; the `exact_match` grader reports `extracted: "unknown:unknown"` against `expected: "pg-stage-07.internal:6432"`. It said it did not know rather than inventing a host.
   Seeded, `01M5SRTYYFKEFMG9GHK40QFHQG`: events 0 and 1 are `memory_read` of `MEMORY.md` (its first fact is "Staging database: host pg-stage-07.internal, port 6432") and `USER.md`, both `loaded_by: harness` at `t_ms` 0; the system prompt (11,588 characters) contains `pg-stage-07`; 1 step (event 4, 5,331 input tokens), event 5 is the final answer `FINAL: pg-stage-07.internal:6432`; `exact_match` passed. The memory was in the prompt before the agent acted, so "used memory" here means "answered from the prompt": the agent made no memory tool call. All 15 off trials and all 15 seeded trials of the 5 non-judged memory-dependent tasks went this way (0 of 15 against 15 of 15).
2. **A memory-distractor task: `dis-02-owners-file` (memory says billing is owned by Priya, `OWNERS.txt` says Sam).** Both configs scored 3 of 3, so neither is "the one that did worse"; the seeded trial `01M5SRTYY6R7KHEJ98VH07GYVQ` is shown because it is the one that could have gone wrong. Event 0 (`memory_read`) carries "billing by Priya" and the system prompt contains it. The agent called `read_file` on `OWNERS.txt` (event 5), got "3|billing: Sam", and answered "Billing service is owned by Sam.  FINAL: Sam" (event 8). "Priya" appears in no assistant message of any of the 3 seeded trials. The explicit instruction ("according to the file OWNERS.txt") beat the memory. `dis-01-json` (USER.md prefers YAML) also passed 6 of 6.
3. **The one delta outside the memory category in A's favour: `det-05-rename`, seeded trial `01M5SRTYYG1J2AHXZX6RS871CE` (1 of 3 failed).** Event 5 is a shell call `find data -type f -name '*.txt' -print0 | xargs -0 -I{} mv '{}' '{}'.md`, which renames `a.txt` to `a.txt.md`; event 8 is a second `find ... -exec bash -c 'mv "$0" "${0%.txt}.md"'` that finds nothing left to move; event 15 lists `data/a.txt.md, data/c.txt.md, data/b.txt.md` and the agent answered that the files were renamed. The `file_state` grader reports `data/a.md ... file does not exist` for the three expected names. The off trials renamed with three separate `mv` commands (e.g. `01M5SRTYYG1J2AHXZX6RS871CD`). Nothing in the transcript involves the memory text: this is a shell-quoting slip of the model, and it is the size of the per-task noise at 3 trials. It is what a delta of +0.33 means in this table. The original plan for this section asked for "a failure where memory was present but unused or misused"; there is none among the seeded trials of the 5 non-judged memory-dependent tasks (15 of 15 passed), and the only seeded failure in the 17 non-judged tasks is this unrelated one, so the card's default (the most surprising delta outside the memory category) was used.

#### Conclusion against H1 to H3 (before kappa)

- **H1 holds on the 5 non-judged memory-dependent tasks.** Off 0 of 15 trials, seeded 15 of 15; delta -1.000, which is at least 0.5 in size, and the interval excludes 0. The interval has no width because all 5 tasks have the same delta; it says the 5 tasks agree, not that the effect in the population of memory tasks is exactly 1. `mem-06` (judged) is PENDING KAPPA.
- **H2 is not contradicted.** The intervals of memory_distractor ([0.000, 0.000]), neutral deterministic ([-0.125, 0.125]) and honesty ([-0.333, 0.000]) contain 0. Their min detectable values are 0.000, 0.125 and 0.167, and the two 2-task groups can only take a few discrete values, so "noise" here means "no difference was visible at this resolution", not "no difference". The honesty bound touches 0 and rests on the one `hon-01` trial that ended on an empty-reply notice (data quality, above). The 4 neutral_judged tasks are PENDING KAPPA. Memory did not hurt on the 2 distractors (6 of 6 each way).
- **The aggregate was not noise.** The pre-registered expectation (9.7) was that the aggregate might be declared noise because the expected delta was about 0.14. Observed: -0.314 [-0.549, -0.098], B better. The reason is that the memory-dependent effect came out at the maximum (-1.000) rather than the assumed 0.5. The verdict is carried by those 5 tasks (above) and may change once the 5 judged tasks are included.
- **H3 holds per call and fails per trial.** The seeded config adds 1,136 input tokens to every call (the first call of each of the 22 tasks differs by 1,133 to 1,137 tokens between the configs), 42 percent more than the roughly 800 assumed. The fixture files hold 881 characters; the system prompt grows by 2,145 characters (9,443 to 11,588), so Hermes frames the memory with about 1,264 characters of its own text (not inspected). Input tokens per call rose from 5,178 to 6,334 (+22 percent). Per trial the seeded config used fewer tokens (22,842 against 27,068) and cost less (0.000437 against 0.000523 USD) because the 6 memory-dependent tasks took 1.5 calls instead of 7.9. On the other 16 tasks it cost 27 percent more per trial (0.000542 against 0.000428 USD), which is the trade-off H3 predicted. Latency was lower under B (delta interval [1.6, 12.2] seconds, A slower); the cost delta's interval contains 0.

#### Actual spend

See 12.2. Candidate trials: 0.0634 USD (sum of `cost_usd`, `price_snapshot` x tokens); judge: 0.0141 USD; total 0.0775 USD for 132 trials.

---

## 11. Contract findings

Every place ADAPTERS.md did not match what building against it required, with the reason.
ADAPTERS.md itself was not edited. Entries 1 to 9 come from the Hermes adapter (P1); entries
10 to 16 come from the minimal loop (P2).

No invariant H-1 to H-11, M-1, M-3, M-4 or R-1 to R-8 had to be weakened, for either adapter.
Entries 2, 6, 7, 8 and 9 say how the text of M-1, M-3, H-9, H-11 and H-4 was read.

The minimal loop passed the conformance suite on its first run with no change to
`test_adapter_conformance.py`, `runner.py` or `graders/`. The invariants that took design
effort, in order: M-3 (every request that reaches the provider must be an `api_call` event,
so the retry loop emits one event per attempt and the library's own retries are off), H-8
(`collect_memory` runs in a fresh process, so `prepare` writes the seed to
`trial_dir/memory/` and the system prompt is built from the same seed in `run`), and H-6
(tool execution errors, a provider that returns no choices and malformed arguments all had to
become results, not exceptions).

1. **Validate endpoint verb.** ADAPTERS 2 says the worker's `GET /adapters/{id}/validate`.
   The settings travel in a body, so the worker serves `POST /adapters/{id}/validate`
   (cards/P1.md section 6 says POST). Behaviour is as specified.
2. **M-1 grep versus base.py.** ADAPTERS 1 requires `base.py` verbatim, and its comments
   contain `"model-a"` and `"anthropic/claude-sonnet-4.5"`, which the M-1 grep (ADAPTERS 5)
   forbids in any file under `worker/adapters/`. The M-1 test scans every adapter file except
   `base.py`. No adapter code branches on a model.
3. **Trace events come from Hermes lifecycle hooks, not callbacks.** ADAPTERS 3 names
   `tool_progress_callback` and `step_callback`. Those carry no call id on completion and no
   HTTP status, so the adapter registers on the plugin manager's `pre_api_request`,
   `post_api_request`, `api_request_error`, `pre_tool_call` and `post_tool_call` hooks
   (`hermes_cli/plugins.py:107`), which carry call ids, durations, status codes and usage.
   The event kinds and fields are exactly those of ADAPTERS 1. The registration reaches into
   `PluginManager._hooks`, a private attribute; the pin on commit `f4ac0bea1e` and the
   conformance suite are what catch a break.
4. **`message` events are emitted as they happen, not after the run.** ADAPTERS 3 lists them
   as emitted from `result["messages"]` after the run. Emitted live from the same hooks, a
   trial killed by R-2 keeps its system, user and assistant messages up to the kill (H-7).
5. **A-6 is false, and the system prompt is still captured (H-3).** `result["messages"]` holds
   only user and assistant rows. The system prompt is taken from the `pre_api_request` hook
   (what is sent on the first call, asserted equal to the request the stub received), with
   `agent._cached_system_prompt` as the fallback. `system_prompt_capture` stays `True`.
6. **M-3 for Hermes needs 3 switches and has 1 residue.** `agent.api_max_retries: 0` is clamped
   to 1 (`agent_init.py:1444`), a single attempt. `agent.auto_recovery_cycles: 0` removes the
   post-exhaustion waits. `HERMES_STREAM_RETRIES=0` (read at `chat_completion_helpers.py:3740`)
   removes the stream layer's silent re-sends. What remains: after a streamed 5xx Hermes
   re-issues 1 non-streaming request per 60 s window (`_STREAM_5XX_PROBE_WINDOW_S`). It is not
   visible as its own `api_call` event; when it succeeds, its response is the call recorded
   as `ok`. Hermes also re-requests after a response it rejects (truncated or malformed tool
   calls, up to 5 times); those requests are recorded as `api_call` events with status
   `retry` and `http_status: null`, because no hook reports their HTTP status. The conformance
   test asserts the provider saw exactly as many requests as there are `api_call` events for
   the 429 case.
7. **`steps` is the count of `ok` events, not `max_steps`.** After the iteration cap Hermes
   makes 1 more toolless request to ask for a summary
   (`agent/turn_finalizer.py:138-163`). It is not an event, so `steps <= max_steps` and
   H-9 holds, but that request's tokens are in no event. The exit reason is `max_steps`
   (A-5: the string is `max_iterations_reached(N/M)`).
8. **H-11 needs the hook.** Hermes strips whitespace from `result["final_response"]`. The
   adapter returns the model's last reply exactly as received (from the hook) when it is the
   same text up to whitespace, and Hermes's own value otherwise.
9. **Tool surface (H-4).** Hermes defers some tools of the `terminal` toolset behind
   `tool_search`, `tool_describe` and `tool_call` bridge tools, which are not in the
   configured set. The adapter writes `tools.tool_search.enabled: "off"` into the trial
   config so the model is offered exactly the tools of the 2 toolsets (`terminal`,
   `process_manage`, `read_file`, `write_file`, `patch`, `search_files`).

10. **Where the minimal loop's memory lives on disk.** ADAPTERS 4 puts the seed in the system
    prompt and says nothing about `collect_memory` (H-8, which reads only from disk). `prepare`
    writes `MEMORY.md` and `USER.md` to `trial_dir/memory/` (outside the workspace, so the
    agent cannot read or edit them) and `collect_memory` reads them back. `memory_final`
    equals the seed, which is correct because `memory_writes` is false.
11. **"5 tries" (DESIGN 6.3, ADAPTERS 4) is read as 1 request plus up to 5 retries.** The
    waits are 1, 2, 4, 8 and 16 s, so a call that never succeeds makes 6 requests and sleeps
    31 s. A 429, a 5xx, a dropped connection and a 200 with no `choices` are retried; any other
    4xx is not. Each request is its own `api_call` event (`retry` while a wait follows, `error`
    for the last). A response with no `choices` has `http_status: null`.
12. **Malformed calls (ADAPTERS 4, "3 consecutive malformed calls").** ADAPTERS names only
    JSON parse failure. The loop also treats a non-object argument, a missing or non-string
    required argument and a tool name that was not offered as malformed, because none of them
    can be executed. A call that is well formed and fails (a missing file, a path outside the
    workspace, a non-zero exit, a timeout) is an ordinary error result and does not count. A
    well formed call resets the count. In the message history the loop replays a malformed
    call's arguments as `{}`: providers reject invalid JSON in an assistant message, and a
    rejected history would turn a scored model fault into an infrastructure error. The trace
    keeps the raw text (`args: {"raw_arguments": ...}`) and the tool result quotes its first
    200 characters.
13. **The last step's tool calls are executed.** When the model's `max_steps`-th reply asks for
    tools, the loop runs them and then stops with `max_steps`; it does not ask for a
    summary (Hermes does, entry 7). `steps` equals `max_steps` in that case.
14. **The two adapters disagreed on 4xx.** The runner read the `retryable` flag of the `error`
    event, the minimal loop set it for every provider failure and Hermes only for 429, 5xx and a
    missing status, so under Hermes a 401 was a scored `agent_error` and under the minimal loop
    an errored `config_invalid` trial. Found at the end of P2 and settled by entry 17.
15. **`seed` (A-8).** The minimal loop sends `seed` on every request. OpenRouter lists `seed`
    in `supported_parameters` for some models and not others (STATE.md: `model-a` lists
    neither `seed` nor `temperature`, `model-b` lists both), and drops what a model does not
    support. `capabilities.seed` stays `True`, as ADAPTERS 4 fixes, and the value means "sent",
    not "honored by every model". The adapter does not read the model row to decide (M-1).
16. **Size and tool output.** The adapter is about 400 lines with its docstrings and blank
    lines, not the 150 ADAPTERS 4 estimates; the extra is the retry schedule, the process-group
    kill for a timed-out shell command (so a background grandchild cannot hold the output pipe
    open) and the path guard. Tool output shown to the model is cut at 10,000 characters with a
    notice; the trace keeps the cut text (the runner's own limit is 20,000 per field).

17. **Contract clarification: the last `error` event carries the HTTP status, and the runner
    classifies from it.** ADAPTERS 2 (H-6) says `run()` must not raise for a model-side or
    tool-side failure; it does not say how a provider's HTTP error is reported. The rule, for both
    adapters, in force since the end of P2 (it supersedes entry 14 and the bullet below):
    - An adapter whose run ended because the provider answered with an HTTP error returns
      `exit_reason: agent_error` and ends its trace with an `error` event (`stage: "run"`) whose
      `http_status` is that integer. `retryable` stays on the event for readers (true for 429 and
      5xx) and is not read by the runner.
    - The runner (`classify_http_status`) turns that into an errored trial: 429 `rate_limited`;
      any other 4xx (400, 401, 402, 403, 404, 408, 413, 422 ...) `config_invalid`; 5xx
      `provider_error`. An errored trial is never scored and the scheduler (P3) retries the
      retryable classes.
    - An `error` event with no integer `http_status` (the harness raised, the connection was
      closed without an answer, a read timed out) leaves the trial a scored `agent_error`. This
      narrows the old DESIGN 6.3 row that sent "connection error, read timeout" to
      `provider_error`; the table now says so. It is the one place the rule is unlike the old text,
      and it favours not discarding trials over treating every silent failure as infrastructure.
    - Where the status comes from. The minimal loop reads it from the exception
      (`APIStatusError.status_code`) or, when OpenRouter answers HTTP 200 with
      `{"error": {"code": 502, ...}}` in the body, from that code. Hermes has no `status_code` in
      that second case (OpenRouter reports a provider that died after it began to answer inside the
      stream or the body, and the SDK raises an error with no HTTP status), so the adapter takes the
      first of: the hook's `status_code`; the status that Hermes's own classification of the error
      stands for (`reason`: `server_error` is 502, `overloaded` 503, `rate_limit` 429, `auth` 401,
      `format_error` 400, ...); Hermes's own hint text for an invalid response ("upstream server
      error (502, 2s)"). The event says which (`http_status_source`: `http`,
      `hermes_reason:<reason>`, `hermes_hint`). A reason that is not an HTTP error (a timeout, a TLS
      failure) maps to no status. The text patterns and the reason table are pinned to Hermes
      `f4ac0bea1e` and covered by `test_error_status_sources.py`; a Hermes bump must re-run them.
    - What is not a status. Hermes raises `content_policy_blocked` for an HTTP 200 reply with
      `finish_reason: content_filter`: a refusal, not an HTTP error, so it has no status and is a
      scored `agent_error` (a real HTTP 400 with the same reason keeps the hook's 400). The hint text
      is read only for `reason == "invalid_response"` and only when the message begins with
      Hermes's own "Invalid API response after N retries:". A failed result that Hermes marks
      `partial` (it had delivered some text before the provider gave out) is an `agent_error` with
      its status, not `invalid_tool_call`; exhausted context compression keeps the old reading.
    - The minimal loop reads the error object of a 200 body whether or not `choices` is empty, and
      accepts a code written as a digit string. A choice whose `finish_reason` is `error` is
      OpenRouter's marker for a failure upstream of it: with no code it counts as 502, the class and
      nothing finer. A body that is not a chat completion at all (HTML, a list, invalid JSON), or
      an empty `choices` list with no error object, is a provider failure with no status and not a
      crash, and so is scored; one of the 30 minimal-loop trials of the final run of the set ended
      that way (`mem-04-cron-tz`, memory off, 6 requests in a row, `choices: 0`), which is what the
      no-status rule costs.
    - Adapter versions. The minimal loop's version is now `1.1.0+<prompt hash>` because its
      behaviour changed; Hermes's version is its commit and cannot show a change in the adapter
      around it, so a config made before this change and one made after it name the same Hermes
      version.
    - Tests: the conformance suite has 4 new tests over both adapters (4xx to `config_invalid`
      with 400, 401 and 404; 5xx to `provider_error`; an upstream 502 behind an HTTP 200 to
      `provider_error`; a closed connection to a scored `agent_error`), and the runner has
      `test_error_classification.py`.
18. **`harness_options.providers_ignored` (OpenRouter `provider.ignore`).** The one harness
    option both adapters accept: a non-empty list of provider names the request must not be
    routed to. Hermes passes it to `AIAgent(providers_ignored=...)`; the minimal loop sends
    `extra_body={"provider": {"ignore": [...]}}` on every request. It is part of the config
    hash, so two configs that differ in it are different configs. It exists because of the
    Darkbloom failures (DESIGN 13.5). ADAPTERS 1 calls `harness_options` opaque and adapter
    specific, so this is not a contract change. Names are compared exactly by OpenRouter, so a
    name with leading or trailing whitespace is refused; a misspelt or wrong-case name is accepted
    and ignores nothing, and `validate` cannot tell, because it sees settings and not the model, so
    it also accepts the option for a model that is not behind OpenRouter. The API sorts and
    de-duplicates the list before hashing.

Not findings about ADAPTERS.md but decisions it left open, recorded here so P2 inherits them:

- **Grader-only files live in `_hidden/`.** DESIGN 7.3 names `equals_file` and `hidden_files`
  but not where they are stored. They go in `<fixture_dir>/_hidden/`, which the runner never
  copies into the workspace (R-5, R-7) and which stays inside the hashed fixture tree (R-6).
- **The card says `hidden/`; the runner says `_hidden/`.** cards/P2.md section 6 puts hidden test
  files under `fixtures/<id>/hidden/`. The runner copies everything in a fixture except a
  top-level `_hidden/` (R-5, R-7), so a directory named `hidden/` would have been copied into the
  workspace and shown to the agent. P2 uses `_hidden/` throughout, as P1 did.
- **`unit_test` runs pytest on its own terms.** Its command runs with `--noconftest`, an empty ini
  file outside the workspace as the config, and the workspace as the root, so a `conftest.py` or
  `pytest.ini` the agent wrote cannot change what the hidden tests mean. A module in the workspace
  that shadows `pytest` or the standard library is not stopped (no sandbox, section 13).
- **`exact_match` tolerates presentation, not content.** `**FINAL: x**`, `> FINAL: x`, an
  answer wrapped in backticks or asterisks, and one trailing full stop are read as `x`. A thousands separator, a unit or a currency symbol is
  not. DESIGN 7.1 says the line is `FINAL: <answer>`; a correct answer in bold is still correct, and
  the independent review of the task set found several such forms that the strict reading rejected.
- **A timed-out trial is graded as failed without running the graders.** One failed
  `grader_result` row per grader keeps D-14 true (the AND over zero rows would be true).
  P2 must give a synthesized `llm_judge` row its judge ids (the CHECK requires them).
- **Provider failures are classified by the runner**, from the `http_status` of the last `error`
  event, as entry 17 says (this replaced the P1 rule that read the `retryable` flag).

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

### 12.2 Estimate and measurement

**The estimate (written before the run).** ASSUMPTION A-10: an average Hermes trial on this task
set makes about 6 model calls with about 6,000 input tokens per call and 300 output tokens per
call, giving about 36,000 input and 1,800 output tokens per trial. With T = 22, N = 5, C = 2: 7.9 M
input and 0.4 M output tokens. At placeholder prices of 0.50 USD per M input and 2.00 USD per M
output that is about 4.75 USD for the candidate runs; the judge adds 5 tasks × 5 trials × 2
configs = 50 calls of about 2,000 tokens, under 0.20 USD at the same prices. The pilot costs 3/5 of
that and is reused.

**The measurement (A-10 resolved).** Source: `experiments/results/01M5SRTYPNZ9EWV1HX8KJGX40N.json`,
`experiments/p5/analyze.mjs`. The run was 132 trials (T = 22, N = 3, C = 2, no extension, see 10.4), with
`model-b` at the registry price of 0.018 USD per M input and 0.09 USD per M output.

| | estimate (A-10) | measured, all 132 trials | A (off), 66 | B (seeded), 66 |
|---|---|---|---|---|
| model calls per trial | 6 | 4.42 (583 calls) | 5.23 | 3.61 |
| input tokens per call | 6,000 | 5,650 | 5,178 | 6,334 |
| output tokens per call | 300 | 78 | 77 | 79 |
| input tokens per trial | 36,000 | 24,955 | 27,068 | 22,842 |
| output tokens per trial | 1,800 | 344 | 402 | 286 |
| input tokens, total | | 3,294,030 | 1,786,459 | 1,507,571 |
| output tokens, total | | 45,433 | 26,545 | 18,888 |
| cost per trial (USD) | 0.00081 at registry prices | 0.000480 | 0.000523 | 0.000437 |
| cost, total (USD) | 0.107 at registry prices | 0.0634 | 0.0345 | 0.0288 |

The A-10 estimate was high by 1.4 times on input tokens per trial and 5.2 times on output tokens per
trial: the model answers in about 78 tokens per call, not 300, and the memory-seeded config finishes the
6 memory tasks in 1.5 calls. No call reported a cache read (`cache_read_tokens` is 0 in every trial), so the
caching saving of 12.3 was not available on this route. Reasoning tokens recorded: 1,801 in all.

**Actual spend (sum over the export).**

| item | USD |
|---|---|
| candidate trials, `cost_usd` (tokens × `price_snapshot`) | 0.0634 |
| judge: 30 gradings, 30,724 input and 22,050 output tokens at `model-a`'s 0.10 / 0.50 | 0.0141 |
| **total** | **0.0775** |

Three reasons this is a floor, not the invoice. (1) The 30 retry and error `api_call` events in 11 trials carry no
tokens (13.9), and Hermes's auxiliary calls, if any, are in no total (A-7). (2) The routed provider is not recorded
per call (13.5): at the cheapest provider left (0.02 and 0.10 USD per M tokens) the same tokens would cost 0.0704 USD
and at the dearest (0.075 and 0.30) 0.261 USD, against 0.0634 at the registry row (Darkbloom's price, which was
excluded from routing). (3) Hermes's own estimate for the same trials, `harness_cost_usd`, sums to 0.0835 USD, 32
percent above the platform's figure; both are reported and the difference was not explained. The budget stop of the
card (25 USD) was never close. The secondary experiment (10.3) was not run.

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
   The judge reads its reference material (`NOTES.md`, `diff.patch`, `util.py`, `test_flaky.py`)
   from the workspace after the run, so an agent that edits those files changes what it is judged
   against; the trace shows the edit, and no grader forbids it. Its model (`model-a`) accepts no
   `temperature` on OpenRouter, so "temperature 0" may be dropped and a re-judge of the same output
   can differ; the stored reasoning and the recorded `judge_model_slug` are what a reader has.
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
   The OpenRouter route is a confound of its own. `openai/gpt-oss-20b` is served by up to 10
   providers whose price and behaviour differ. One of them, Darkbloom (the cheapest, and the
   source of `model-b`'s registry price), answered HTTP 502 `provider_unavailable` ("Upstream
   error from Darkbloom: inference generation failed", raw body
   `{"code": 502, "message": ..., "metadata": {"error_type": "provider_unavailable"}}`, captured
   on 2026-10-24 for `det-03-slugify` at step 4 of one attempt) on `det-03-slugify` and
   `det-04-median` in 9 of 9 attempts under Hermes, while the same tasks passed under the minimal
   loop and with Darkbloom excluded. Configs for runs that compare anything should set
   `harness_options.providers_ignored = ["Darkbloom", "Groq"]` (entry 18). Ignoring Darkbloom alone
   left `det-04-median` scored in 3 of 3 attempts but `det-03-slugify` in only 1 of 5, the other 4
   errored: OpenRouter then routed to Groq, whose API validates the model's tool call against the tool's schema and answers
   400 ("Tool call validation failed: parameters for tool patch did not match schema: missing
   properties: 'mode'"), which is the model's malformed call and an errored trial here. With both
   ignored, 6 of 6 attempts of `det-03-slugify` and `det-04-median` scored. Three things follow. The
   provider is not pinned: OpenRouter picks among the rest (Hermes sends a top-level `session_id`,
   `<trial_id>-<attempt>`, that OpenRouter uses as a sticky routing key, and the minimal loop sends
   none, so routing may be sticky for one harness and per request for the other, a confound of its
   own; the serving provider is not recorded per call), so prices (0.02 to 0.075
   USD per million input tokens, 0.10 to 0.30 output, from the endpoints listing of 2026-10-24)
   and tool-call formatting vary between trials, and `model-b`'s registry price (0.018 / 0.09,
   Darkbloom's) understates the cost of a routed call. A provider's own rejection of a malformed
   tool call is an errored trial here, though it is the model's doing. And a provider that fails
   deterministically on one conversation will do so again at temperature 0, so an errored trial is
   not always fixed by a retry.
6. **No sandbox.** The agent's shell runs in the worker container with the workspace as
   cwd. Host side effects are limited to the container, not prevented. A task that asks
   for network access would succeed or fail based on the container's network, which the
   platform does not control or record. The grader-only files (hidden tests, expected files, and
   the task JSON that holds each `exact_match` answer) are mounted read-only at `/tasks` in that
   same container, so an agent that went looking could read them. No prompt points there and the
   runner keeps them out of the workspace (R-5, R-7), but the only protection against a search of
   the filesystem is that the trace would show it: a `tool_call` whose arguments name `/tasks`.
   The same holds for the trial's own directory: `../spec.json` (which holds the task's graders)
   and, for the minimal loop, `../memory/` (the seed) are one level above the workspace. The minimal
   loop's shell drops environment variables whose names end `_KEY`, `_TOKEN` or `_SECRET`; Hermes's
   terminal drops its own provider blocklist (`tools/environments/local_env_policy.py`, which
   includes `OPENROUTER_API_KEY`) and passes every other worker variable, so a credential under a
   new name would reach it. Real confinement (a separate uid or a mount namespace for
   the agent's shell) is not built.
7. **Single run, single day.** The experiment is 1 run on 1 day against 1 provider
   backend. Reproduction (section 6.2) re-runs the inputs; it cannot re-run the backend.
8. **Pre-registration is procedural, not cryptographic.** D-10 stops edits through the
   API; it does not stop a direct database edit. The committed export in `experiments/`
   with its git history is the audit trail.
9. **Hermes's retries are invisible in the totals and its notice can name the wrong cause.**
   In the primary run 30 `api_call` events (28 `retry`, 2 `error`) in 11 of 132 trials had no
   HTTP status and 0 tokens; none of them is in a token or cost sum, so spend is understated by
   the retried calls, and the size of that is unknown. In 2 trials Hermes gave up after 5 and
   replaced the answer with a notice that blames the output length limit, although the events
   show no output; the trial is graded as a wrong answer and exits `invalid_tool_call`, which
   the HTTP-status rule (entries 17 and 18) does not catch, because no status is attached. One of
   them moved the `hon-01` pass rate of the memory-off config from 1.00 to 0.67. A reader of a
   per-task delta of 1 trial in 3 cannot tell this from a model slip without opening the trace.
10. **N = 3 resolves large effects only.** The pilot rule chose N = 3 because the observed
    within-task variance (0.0606) was a quarter of the Bernoulli worst case. The rule's h(N) ignores
    the spread between tasks. The 2-task groups (memory_distractor, honesty) can take only a few
    values and their intervals are `[0, 0]` or touch 0; their `min_detectable` (0.000 and 0.167) says
    what they could have seen, not that nothing is there. Per-task deltas of +-0.33 are single
    trials (`det-05`, `det-07`, `hon-01`).
11. **The memory block costs 1,136 tokens per call, not the 800 of H3.** The fixture files hold 881
    characters and the system prompt grows by 2,145; the framing is Hermes's. It is a constant
    added to every call, so the seeded config's cost per trial rises with the number of calls on tasks
    that memory does not help (+27 percent on the 16 tasks that are not memory-dependent) and falls on
    the ones it does help (1.5 calls instead of 7.9).
12. **The headline depends on the judge's policy.** Before a `judge_validation` row exists the
    comparison removes the 5 judge-graded tasks (17 tasks remain, `memory_dependent` has 5 of 6), so a
    number quoted from a comparison made before kappa is not the 22-task number. The persisted
    `comparison_run` records which policy it applied.

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
