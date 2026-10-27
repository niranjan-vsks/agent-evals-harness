# CHEATSHEET.md

Read twice before recording. Every number has its source.

---

## 1. Every number in one place

### The setup

| what | value | source |
|---|---|---|
| tasks | 22 (6 memory_dependent, 2 memory_distractor, 8 neutral deterministic, 4 neutral judged, 2 honesty) | DESIGN 7.2 |
| grader mix | exact_match 10, file_state 4, unit_test 3, trace_check 1, llm_judge 5 | DESIGN 7.2 |
| judged tasks | 5: jdg-01 to jdg-04, mem-06 | DESIGN 10.4 |
| harnesses | 2: Hermes (commit `f4ac0bea1e`), minimal_loop | DESIGN 10.4, STATE 0 |
| models | 2: model-a `anthropic/claude-haiku-5.5` (also the judge), model-b `openai/gpt-oss-20b` | DESIGN 10.4 |
| configs in the data | 3: `hermes memory off`, `hermes memory seeded`, `hermes memory off, claude-haiku-5.5` | exports |
| common settings | tools shell + files, skills off, temperature 0, max_steps 15, max_output_tokens 2048, timeout 300 s, Darkbloom and Groq ignored | DESIGN 10.4 |
| memory fixture | `team-memory-v1`, 881 characters across the 2 files; adds 1,136 input tokens per call | DESIGN 10.4 H3 |

### The primary experiment (`01M5SRTYPNZ9EWV1HX8KJGX40N`)

| what | value | source |
|---|---|---|
| design | Hermes, model-b, memory off (A) against seeded (B) | DESIGN 10.1 |
| N | 3 per (task, config) | DESIGN 10.4 |
| trials | 132: 132 done, 0 errored, 0 retried, 0 rate-limited | DESIGN 10.4 |
| wall time | 29.0 minutes, concurrency 2 | DESIGN 10.4 |
| pilot variance s2 | 0.0606 (worst case 0.25) | DESIGN 10.4 |
| h(3), h(5), h(8) measured | 0.0840, 0.0651, 0.0514 | DESIGN 10.4 |
| pass rate A, B | 0.561, 0.894 | DESIGN 10.4; compare.csv |
| **delta (A - B)** | **-0.333, 95 percent CI [-0.515, -0.167], verdict B_better** | DESIGN 10.4 |
| min detectable | 0.174 | DESIGN 10.4 |
| sign test | A won 1, B won 11, 10 tied, p = 0.0063 | DESIGN 10.4 |
| memory_dependent | 0.000 against 0.944, -0.944 [-1.000, -0.833], B_better (0 of 18 against 17 of 18 trials) | DESIGN 10.4 |
| memory_distractor | 1.000 against 1.000, [0.000, 0.000], noise | DESIGN 10.4 |
| neutral (12 tasks) | 0.722 against 0.833, -0.111 [-0.250, 0.028], noise | DESIGN 10.4 |
| honesty | 0.833 against 1.000, -0.167 [-0.333, 0.000], noise | DESIGN 10.4 |
| neutral_judged (4, not pre-registered) | -0.333 [-0.583, -0.083] by the judge; -0.167 [-0.500, 0.167] noise by human labels | DESIGN 10.4 |
| with human labels replacing the judge | -0.318 [-0.515, -0.136], B_better, sign test p = 0.0386 | DESIGN 10.4 |
| before kappa (17 tasks, policy excluded) | -0.314 [-0.549, -0.098], B_better | DESIGN 10.4 |
| calls per trial | 5.23 (off), 3.61 (seeded) | DESIGN 10.4 |
| cost per trial | 0.000523 (off), 0.000437 (seeded) USD; delta CI contains 0 | DESIGN 10.4 |
| latency per trial | 25.9 s (off), 20.5 s (seeded); delta [1.6, 9.8] s, excludes 0 | DESIGN 10.4 |
| spend | 0.0634 candidates + 0.0141 judge = 0.0775 USD | DESIGN 12.2 |

### The judge

| what | value | source |
|---|---|---|
| items | 30, 1 labeler, blind | DESIGN 10.4 |
| raw agreement | 0.8333 (25 of 30) | DESIGN 10.4 |
| kappa | **0.6377** | DESIGN 10.4 |
| 95 percent interval | **[0.321, 0.902]** (10,000 resamples, seed 20261023) | DESIGN 10.4 |
| policy | **trusted** (threshold 0.6) | DESIGN 8.3, 10.4 |
| confusion | both pass 8, judge pass and human fail 4, judge fail and human pass 1, both fail 17 | DESIGN 10.4 |
| where the disagreements are | 4 of 5 on `jdg-04-flaky`; 1 on `mem-06` | DESIGN 10.4 |

### The secondary experiment (`01M5STXWYMRDGQFJ47DNK5Y83S`)

| what | value | source |
|---|---|---|
| design | Hermes, memory off, model-a (A) against model-b (B), N = 3, 132 trials, 32.4 minutes | DESIGN 10.5 |
| stored verdict | +0.106 [0.030, 0.197], A_better | DESIGN 10.5 |
| 17 non-judged tasks only | +0.078 [0.000, 0.176], noise | DESIGN 10.5 |
| leak-affected passes scored as fails | +0.061 [0.000, 0.136], noise | DESIGN 10.5 |
| **how to say it** | **no reliable difference** | DESIGN 10.5, STATE "Judge validation" Found 3 |
| spend | 0.0610 USD (a floor) | DESIGN 10.5 |

### The platform

| what | value | source |
|---|---|---|
| both experiments | 264 trials, 0 errored, 0.139 USD at the platform's accounting | DESIGN 10.5, 12.2 |
| Overview spend tile | 0.109366 USD (candidate trials only, judge not included) | STATE P8 |
| failed trials, categorised | 85: judge_criteria_unmet 36, abstained 20, step_exhaustion 10, wrong_tool_usage 6, wrong_answer 6, no_final_answer 5, tool_error_unrecovered 1, grader_disagreement 1 | STATE "Judge validation" |
| tests | API 734 passed (3 skipped), web 253, worker 643 passed (28 skipped) | STATE P8, "Audit fixes (code)" |
| cost estimate before the run | 4.75 USD at placeholder prices, N = 5 | DESIGN 12.2 |

---

## 2. The decision ladder: pass, fail or noise

Recite it in this order.

1. **Trial.** Did it finish? An infrastructure error (429, 5xx, worker crash) is retried, up to 3 attempts, and never scored. Running out of steps or time **is** scored, as a fail.
2. **Graders.** Every grader on the task must pass; `passed` is their AND. A timeout cannot pass.
3. **Judge policy.** If the task has an `llm_judge` grader: kappa 0.6 or more counts it (`trusted`), 0.4 to below 0.6 counts it with a low-confidence badge (`flagged`), and anything lower, or no validation, removes it from the headline (`excluded`).
4. **Per task.** Pass rate = passes / scored trials, under A and under B. Delta = rate A minus rate B.
5. **Aggregate.** Mean of the per-task deltas. Resample the tasks 10,000 times (seeded) and take the 2.5 and 97.5 percentiles.
6. **Guard.** Fewer than 2 paired tasks: `insufficient_data`, no interval.
7. **Verdict.** The interval contains 0 (touching counts): **noise**. Otherwise A_better or B_better by the sign. No minimum effect size.
8. **Report beside it.** min detectable = half the interval width; the sign test; McNemar only if N = 1; reliability `partial` if anything is errored, unfinished or unpaired.

---

## 3. The 10 questions most likely to be asked

**1. Why a paired bootstrap and not McNemar?**
With N = 3 each task has a pass rate, not 1 outcome. McNemar would throw that away or pair trials arbitrarily.
Bootstrapping tasks keeps the information and needs no distribution assumption. McNemar runs only at N = 1.

**2. How did you pick N, and why 3 when the design said 5?**
The rule, written before the run: pilot at 3, then the smallest N with projected half-width at most 0.15.
The measured variance was 0.0606, a quarter of the worst case, so h(3) = 0.084 met the rule. The pilot never showed the delta.

**3. Can I trust the judge?**
It is validated: kappa 0.6377, interval [0.321, 0.902], 30 labels, 1 labeler. That is "trusted" by the pre-set rule, but the lower bound is below 0.4.
The headline holds with human labels in place of the judge: -0.318 [-0.515, -0.136].

**4. Didn't you just write tasks that memory wins?**
Yes, deliberately, for 6 tasks, and with 16 controls that should not move. The 2 distractors check that memory does not override instructions.
The claim is "memory helped on tasks written to need it", not "memory helps".

**5. What is noise in your results?**
Distractor, neutral and honesty groups all contain 0. Per-task deltas of 0.33 are single trials (det-05, det-07, hon-01).
The model-a against model-b result is treated as no reliable difference.

**6. How do I add a harness or a model?**
Harness: 1 directory with a class that meets the contract, 1 registry line, green conformance suite.
Model: 1 JSON row in `models.json`. Nothing else changes.

**7. Can the agent cheat by reading the answers?**
Since the audit fix it runs as an unprivileged user; the task files and output folder are closed to it, and a probe checks this before every trial.
The committed runs predate the fix: the primary read the graders 0 of 132 times, while model-a in the secondary did 7 of 66.

**8. Is it reproducible?**
The inputs are: config hash, task hash, memory hash, price snapshot, seeds, judge prompt hash. The outputs are not, because the model is not deterministic.
The interval is the statement of how much they are expected to move.

**9. What did it cost?**
Primary 0.0775 USD including the judge; both experiments 0.139 USD.
It is a floor: Hermes retries carry no tokens, and the provider route is not pinned. Cached tokens are now priced, but the old rows were not recomputed.

**10. What would you do with more time?**
More tasks per category, a second labeler, a per-trial user or a mount namespace, and a re-run of the model experiment on the fixed stack.
Also an import endpoint for exports, and recording the serving provider per call.

---

## 4. THE TRAPS

1. **Same config, 2 pass rates.** The Overview pools every trial of a config across experiments; Compare uses 1 experiment and applies the judge policy. `hermes memory off`: Overview **0.568**, primary Compare **0.561** (computed from the 2 exports). Before kappa the gap was 0.568 against 0.667 (STATE P8 Found 1). The chart caption only names the judge reason, which no longer applies under `trusted`; say "pooled across both experiments".
2. **N ended at 3, not the 5 the design expected,** by the pilot rule and the measured variance (DESIGN 10.4).
3. **Kappa's interval reaches below the 0.4 line:** [0.321, 0.902], 1 rater, 30 items. Say "validated", never "accurate".
4. **Cost was a floor** before cached-token pricing was added (commit `08de24d`); the committed P5 numbers are still that floor.
5. **The experiment data lives in a Docker volume (`p5run_dbdata`) plus a committed dump**, not in the repo stack. The default stack on :8080 does not hold it.
6. **The second model experiment is noise on the non-judged tasks** (+0.078 [0.000, 0.176]). The Overview shows it as "A better by 0.106"; it is the **newest** stored verdict, so it may be listed **first**. Say "no reliable difference".
7. **Delta is A minus B.** Negative means the seeded config (B) is better. Compare's pill flips it to "B better by 0.333 [0.167, 0.515]".
8. **The memory interval [-1.000, -0.833] is narrow because the 6 tasks agree,** not because the effect is known to be 0.944.
9. **The 4-task `neutral_judged` row is B_better by the judge and noise by the labels,** and was not pre-registered. Do not cite it as a memory effect.
10. **The honesty -0.167 is 1 trial** where Hermes gave up and its notice became the answer (`01M5SRTYY6R7KHEJ98VH07GYVR`).
11. **Seeded memory was put in the prompt by the harness** (`loaded_by: harness`); the agent made no memory tool call. "Used memory" means "answered from the prompt".
12. **The p5run worker is the old image.** Do not rebuild it before recording: a new worker behind p5run's old compose file fails every trial closed (STATE "Audit fixes (code)", Found 1).
13. **Per call, memory made Hermes dearer** (+1,136 tokens); per trial it was cheaper only because memory tasks finished in 1.5 calls instead of 7.9. On the other 16 tasks seeded cost 27 percent more (DESIGN 10.4 H3).

---

## 5. What I must NOT claim, and the true version

| do not say | say instead |
|---|---|
| "memory makes agents better" | "seeded memory beat no memory on these 22 tasks, by 0.333; almost all of it on the 6 tasks written to need memory" |
| "the judge is accurate" or "the judge is trusted" (as a fact about the world) | "the judge is validated: kappa 0.64, interval 0.32 to 0.90, 30 labels from 1 labeler; trusted by the rule we fixed in advance" |
| "model-a is better than model-b" | "no reliable difference: the interval touches 0 once the judged tasks or the leak-affected trials are removed" |
| "trials are sandboxed" or "contained" | "isolated between trials: fresh process, fresh directory, unprivileged user; not contained from the host, network not controlled" |
| "the results are reproducible" | "the configuration is reproducible by hash; the output is not, and the interval says how much it should move" |
| "this proves" | "on this task set, at N = 3" |
| "statistically significant" for any noise row | read the verdict the page shows |
| "zero false positives" | "the noise rule is tested on both sides of the boundary" (audit F) |
| "production ready" | "the take-home deliverable, with its limits in DESIGN 13" |
| "the cost is X" | "the platform's figure is X, a floor" |
| "measured in general" | "measured on 22 tasks" |
| "N = 3 is enough" | "N = 3 met the pre-registered rule and resolves large effects only" |
| "the minimal loop is our competitor to Hermes" | "the minimal loop is the second harness that proves the contract" |
| "the experiment runs from the repo" | "it ran on an isolated stack; the data comes back from the committed dump" |
