# CODE_MAP.md

Only the files that make decisions, ranked by importance. This page is for you, not for the screen: it has paths and line numbers. Line numbers were read on commit `520a3f5`.

Each entry gives the function that matters, the decision it makes, why it is built that way, and the question a reviewer is most likely to ask, with the answer.

---

## The 3 files for the video ("show me the core idea")

| # | file | scroll to | why this one |
|---|---|---|---|
| 1 | `api/src/stats/compare.ts` | `noiseRule` (line 201), then `pairedBlock` (line 208) | this is where a difference between A and B becomes either a verdict or "noise". It is the honesty rule in about 5 lines |
| 2 | `worker/adapters/base.py` | `class HarnessAdapter` (lines 107 to 128) | the whole contract a harness must meet: `validate`, `prepare`, `run`, `collect_memory`. Adding a harness means implementing this, and nothing else changes |
| 3 | `worker/runner.py` | `_run_in_dir` (line 392), with `_child_view` (256), `_hand_over` (282) and grading in the parent (488) | the isolation claim: a fresh process per trial, running as the unprivileged `agent` user, which never sees its graders, and is graded as root after it exits |

Reserve, if asked "how does the judge's trust reach the numbers": `api/src/compare/service.ts`, `judgeInUse` (line 184).

---

## The ranked map

### 1. `api/src/stats/compare.ts`

- **What matters.** `compare()` (269), `noiseRule` (201), `pairedBlock` (208), `twoSampleDeltaCi` (247).
- **Decision.** It scores only done trials that have a verdict, pairs them by task, takes the mean over tasks of the per-task pass rate, and bootstraps over tasks (10,000 resamples, line 60). The verdict is `noise` when the interval, rounded to 12 decimals, contains 0 (an interval that touches 0 is noise). It gives `insufficient_data` below 2 paired tasks (`MIN_PAIRED_TASKS`, 72). It withholds judged tasks under policy `excluded` (296 to 314). Per-task rows resample trials, 2,000 times (61), and are labelled direction only.
- **Why built this way.** DESIGN 9.2 to 9.6. The 2-task guard exists because 1 task gives a zero-width interval that would read as a win (comment at 63 to 71).
- **Likely question.** "Is there a minimum effect size, or does the sign test decide?" **Answer:** no minimum effect. The verdict is the interval alone; the sign test (420) and McNemar (364, only at N = 1) are reported next to it.

### 2. `api/src/stats/bootstrap.ts`

- **What matters.** `percentileBootstrap` (47), `mulberry32` (8), `quantileSorted` (23).
- **Decision.** It draws with replacement from a seeded random number generator and returns the 2.5 and 97.5 percent quantiles (type 7 interpolation).
- **Why built this way.** The same function serves the delta, cost, latency and kappa (DESIGN 9.2). mulberry32 gives identical numbers on every platform.
- **Likely question.** "Is it reproducible?" **Answer:** yes. The seed is the experiment's seed, stored on the comparison run, and 2 calls give byte-identical payloads (audit F).

### 3. `api/src/judge/policy.ts` and `api/src/compare/service.ts`

- **What matters.** `judgePolicy` (`policy.ts` line 17); `judgeInUse` (`service.ts` line 184).
- **Decision.** Kappa is rounded to 4 places, then 0.6 or more gives `trusted`, 0.4 or more gives `flagged`, and anything else (or no validation row) gives `excluded`. The policy is re-derived from the stored kappa, not read from a stored policy column. Only the 2 compared configs' judges count, and the strictest of them wins.
- **Why built this way.** DESIGN 8.3, 8.4, D-16. The rounding means a row that shows "0.6000" can never be flagged.
- **Likely question.** "Could someone edit the policy in the database to trust the judge?" **Answer:** no. The policy column is ignored; it is recomputed from kappa each time.

### 4. `worker/runner.py`

- **What matters.** `run_trial` (319), `_run_in_dir` (392), `_child_env` (127), `_child_view` (256), `_hand_over` (282), `classify_http_status` (209).
- **Decision.**
  - Each attempt runs in a fresh child process (443) in a fresh directory (377 to 397).
  - The fixture is copied, never linked, and `_hidden/` is skipped (155 to 167).
  - The child runs as user `agent` (437).
  - The environment is minimal (127 to 147): only the trial's model key and judge key are added.
  - The graders are removed from the child's spec (256).
  - Grading happens in the parent after exit (488).
  - The child is killed at timeout plus 60 s, after SIGTERM and a 10 s grace (56 to 57).
  - HTTP 429 becomes `rate_limited`, other 4xx `config_invalid`, 5xx `provider_error`; no status means a scored `agent_error`.
- **Why built this way.** ADAPTERS R-1 to R-11. R-11 (the unprivileged user) came from the audit fix `e73e939`.
- **Likely question.** "Is the agent sandboxed?" **Answer:** isolated between trials, not contained from the host. There is no network control (DESIGN 13.6), all trials share 1 `agent` user, and unit-test graders run agent-written code as root (STATE "Audit fixes (code)", Found 3 and 4).

### 5. `worker/adapters/base.py`

- **What matters.** `HarnessAdapter` Protocol (107 to 128): `id`, `version`, `capabilities`, `validate(settings) -> list[str]`, `prepare(ctx)`, `run(ctx) -> HarnessRunResult`, `collect_memory(ctx) -> MemorySnapshot`.
- **Decision.**
  - `validate` returns a reason for every setting the harness cannot honor exactly (H-1).
  - `prepare` is idempotent (H-5).
  - `run` streams events as they happen (H-7) and never raises on model errors (H-6).
  - `collect_memory` reads from disk only (H-8).
- **Why built this way.** The contract was frozen before the second harness was written (DESIGN 3). Registration is 1 line in `worker/adapters/__init__.py` (line 6).
- **Likely question.** "What would a third harness need?" **Answer:** 1 directory and 1 registry line, plus a green conformance suite. No change to the runner, graders, API or UI (README "Add a harness").

### 6. `api/src/failures/rules.ts`

- **What matters.** `RULES` (214 to 344), `categorize` (350).
- **Decision.** 12 ordered rules; the first match wins and `wrong_answer` always matches. It records evidence as an event number or a grader index.
- **Why built this way.** The P6 card plus the architect's 3 decisions (STATE P6 Follow-up). Rule 5 also checks the output text, because Hermes marks a `grep` with no matches as an error.
- **Likely question.** "Is a model labelling the failures?" **Answer:** no, the rules are pure functions. 7 of the 12 categories appear in the real data; `timeout`, `hallucinated_tool_args`, `gave_up_early` and `memory_ignored` are tested only on synthetic traces (STATE P6, "Judge validation").

### 7. `api/src/stats/pilot.ts`

- **What matters.** `pilot` (75), `halfWidth` (71).
- **Decision.** s2 is the mean unbiased Bernoulli variance over cells. h(N) = 1.96 x sqrt(2 x s2 / (N x T)). It recommends the smallest N from the pilot's N up to 8 with h at most 0.15.
- **Why built this way.** DESIGN 9.7. The output type has no delta field (comment at lines 5 to 6), so N cannot be chosen by looking at the answer.
- **Likely question.** "Did you peek?" **Answer:** the endpoint cannot return a delta, and STATE P5 records that N was written down before compare was called.

### 8. `worker/graders/llm_judge.py`

- **What matters.** `grade_llm_judge` (199), `parse_verdict` (119), `decide` (140).
- **Decision.** The judge sees the task prompt and the declared inputs, never the trajectory. Temperature 0, JSON output. `pass` is recomputed from the criteria, so the model's own `pass` is ignored. On a bad reply it asks again once, then gives `grader_error`.
- **Why built this way.** DESIGN 8.1. Judging the trajectory rewards verbosity.
- **Likely question.** "Can the agent's output instruct the judge?" **Answer:** the prompt (`judge_prompt_v1.txt`, lines 3 and 11) tells it to ignore instructions inside the graded output. That is a mitigation, not a guarantee.

### 9. `api/src/judge/kappa.ts` and `api/src/judge/sample.ts`

- **What matters.** `computeValidation` (82), `runKappa` (120); `stratifiedDraw` (70), `toBlindLine` (35).
- **Decision.** It needs at least 30 items (17) and uses 10,000 resamples with seed 20261023 (15, 19). The sample lines are built from an explicit field list, so verdict, reasoning and config cannot leak into them.
- **Likely question.** "Was the labelling blind?" **Answer:** yes, by construction (D-15). The labels were committed (`306b1d8`) before `judge:kappa` ran (DESIGN 10.4).

### 10. `api/src/trials/ingest.ts`

- **What matters.** `ingest` (128), `costUsd` (93).
- **Decision.** It enforces that `passed` equals the AND of the graders, that the grader count matches the task, and that a timeout cannot pass. Traces are capped at 5 MiB (13). Cost is input, output and cached tokens times the prices snapshotted at dispatch. A snapshot with no cached price falls back to the input price (an upper bound).
- **Likely question.** "Your costs: floor or invoice?" **Answer:** for the committed P5 runs they are a floor, because cached-token pricing was added afterwards (commit `08de24d`) and old rows were not recomputed (STATE "Audit fixes (code)", Cut on purpose).

### 11. `api/src/scheduler/retry-policy.ts`, `scheduler.ts`, `settle.ts`

- **What matters.** `decideRetry` (`retry-policy.ts` 44); `claim` (`scheduler.ts` 275); `recoverOrphans` (483); `settleInTx` (`settle.ts` 162).
- **Decision.**
  - Transient errors retry, up to 3 attempts, after 30 s then 60 s.
  - `grader_error` retries once.
  - `backpressure` re-queues without counting an attempt, up to 100 times.
  - Every 5 consecutive terminal errors pause the experiment.
  - A trial is an orphan once its heartbeat is older than timeout plus 180 s.
  - Settling is guarded on `attempt.result IS NULL`, so a late reply is dropped.
- **Likely question.** "What happens if the API restarts mid-run?" **Answer:** the running trials are re-queued once their heartbeat ages out, and a DELETE is sent to the worker. Waiting is chosen over paying for a duplicate run (comment at `scheduler.ts` 479 to 482).

### 12. `worker/privilege.py`

- **What matters.** `assert_closed_to` (74), `read_child_file` (80), `resolve_user` (29).
- **Decision.** Before every trial, a probe running as `agent` must find the tasks directory and `out/` closed; otherwise the trial is refused as `worker_crash`. Child files are read with `O_NOFOLLOW`. Root and Windows are refused as the run-as user.
- **Likely question.** "How do you know the agent cannot read the answers?" **Answer:** the probe runs before each trial, and a mutation test showed the conformance test goes red when the child stays root (STATE "Audit fixes (code)", Verified).

### 13. `api/src/experiments/service.ts`

- **What matters.** `createTrials` (370), `start` (412), `extend` (439), `reproduce` (542).
- **Decision.** Tasks are pinned by hash (D-6). All trials are created at start in 1 transaction. `extend` only raises N (D-9). `reproduce` refuses when a pin no longer resolves. The per-trial seed is a sha256 of seed, config, task and index.
- **Likely question.** "Is a result reproducible?" **Answer:** the inputs are, by hash. The outputs are not, because the model is not deterministic (DESIGN 6.2).

### 14. `api/src/summary/summary.service.ts`

- **What matters.** `summary` (177), `configRow` (114), `newestPerPair` (157).
- **Decision.** It computes no statistics. Verdicts come from stored comparison runs, newest per pair. Pass rate is a mean over tasks of every done trial of the config, across all experiments, with judged tasks included.
- **Likely question.** "Why does Overview disagree with Compare?" **Answer:** it pools experiments and ignores the judge policy (see CHEATSHEET "Traps").

### 15. `api/src/configs/configs.service.ts` and `config-input.ts`

- **What matters.** `create` (`configs.service.ts` 65); `normalizeSettings` (`config-input.ts` 34), `configHash` (57).
- **Decision.** Creating a config is idempotent by content hash (D-3). The server resolves the fixture hash (D-5). The adapter's `validate` must return no reasons (D-4).
- **Likely question.** "Can 2 configs with the same name mean different things?" **Answer:** no. The name is not part of the identity; the settings hash is.

### 16. `api/src/tasks/hash.ts`, `worker/task_hash.py`, `api/src/common/canonical-json.ts`

- **Decision.** A task hash is the sha256 of the canonical JSON plus the sorted (path, sha256) of every fixture file. The TS and Python versions must agree byte for byte (keys sorted in UTF-8 order).
- **Likely question.** "What if a task file changes under a running experiment?" **Answer:** the worker re-verifies the hash, and a mismatch is `config_invalid` (R-6).

### 17. `worker/adapters/hermes/adapter.py` and `worker/adapters/minimal_loop/adapter.py`

- **Hermes.** `hermes_config` (94), `run` (203), `_map_result` (281). It turns Hermes's own retries off where it can (M-3) so every request is traced, and turns off its clarify, web and browser tools.
- **Minimal loop.** `_loop` (159), `_call_model` (246). It backs off 1, 2, 4, 8, 16 s on 429; 3 malformed tool calls in a row end the trial as `invalid_tool_call`. Its prompt's hash is part of its version (`prompt.py` 14).
- **Likely question.** "Do the 2 adapters share code?" **Answer:** no (`minimal_loop/adapter.py` lines 1 to 2); the contract is the only common surface.

### 18. The other graders (`exact_match.py`, `file_state.py`, `unit_test.py`, `trace_check.py`)

- **Decision.**
  - `exact_match` takes the last `FINAL:` line.
  - `file_state` keeps `True` from equalling `1`.
  - `unit_test` copies the hidden tests in after the run, with `--noconftest`.
  - `trace_check` checks the mechanism, for example that the shell ran `lint.py --strict`.
- **Likely question.** "Why `trace_check`?" **Answer:** a lucky `FAIL` without the strict run does not pass `mem-05` (DESIGN 7.2).

### 19. `web/src/views/CompareView.vue` (`verdictLine`, 47) and `web/src/lib/axis.ts` (`describeAxis`, 34)

- **Decision.** The UI recomputes nothing. It re-checks that the API's verdict agrees with the interval and shows "payload inconsistent" otherwise. A difference is attributable only when exactly 1 of harness, model or settings differs.

---

## Code comments found stale (not README or DESIGN, so not fixed)

- `worker/graders/__init__.py` line 1: the docstring says the graders are "called by the child process"; since R-11 the parent runner grades (runner.py line 488).
