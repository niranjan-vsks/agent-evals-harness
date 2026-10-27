# Executive verdict

**On 22 tasks, Hermes with seeded memory beat Hermes with memory off: pass rate 0.894 against 0.561, a difference of -0.333 (A minus B) with a 95 percent interval of [-0.515, -0.167] (DESIGN 10.4).**
**Almost all of it comes from the 6 tasks written to need memory (0 of 18 trials against 17 of 18). The other groups show no difference at this resolution, and a model-against-model comparison found no reliable difference.**

---

## The result

| | value | source |
|---|---|---|
| design | 1 harness (Hermes), 1 model (`gpt-oss-20b`), memory off against seeded, 22 tasks, N = 3, 132 trials, 0 errored | DESIGN 10.4 |
| headline | -0.333 [-0.515, -0.167], seeded better; sign test 11 to 1, 10 tied, p = 0.0063 | DESIGN 10.4 |
| memory-dependent (6 tasks) | -0.944 [-1.000, -0.833] | DESIGN 10.4 |
| distractor, neutral, honesty | every interval contains 0: noise | DESIGN 10.4 |
| with human labels in place of the judge | -0.318 [-0.515, -0.136], still seeded better | DESIGN 10.4 |
| spend | 0.0775 USD including the judge (a floor) | DESIGN 12.2 |

## What the platform proves

- **A new harness or model is an adapter, not a rewrite.** 2 harnesses that share no code run behind 1 frozen contract, and the same conformance suite passes over both. A harness is 1 directory plus 1 registry line; a model is 1 JSON row (README; audit section I).
- **The judge was validated, with a measured kappa and its interval.** 30 blind labels gave agreement 25 of 30 and kappa 0.6377 [0.321, 0.902]. That is `trusted` by the threshold fixed before labelling (DESIGN 8.3, 10.4).
- **Trials are isolated from each other.** Each runs in a fresh process and a fresh directory, as an unprivileged user that cannot read the answers, and is graded after it exits (ADAPTERS R-11; STATE "Audit fixes (code)").
- **Differences that are not real are called noise.** The verdict is "noise" whenever the interval contains 0. It is tested on both sides of the boundary and the bootstrap is seeded and reproducible (audit F).
- **N was chosen without seeing the answer.** The pilot endpoint returns variances, never a delta. The pre-registered rule gave N = 3 (DESIGN 9.7, 10.4).

## What it does not prove

- **Task-set size.** 22 tasks, 6 on memory, written by the author. The result generalises only to tasks like them. N = 3 resolves large effects only: the smallest effect the headline could see was 0.174 (DESIGN 13.1, 13.10).
- **Judge bias and the single rater.** 1 judge model, 1 prompt, 1 human labeler, 30 items. The interval's lower end, 0.321, is below the 0.4 exclusion line. 4 of the 5 disagreements are on 1 task. There is no human-to-human check of the labels (DESIGN 10.4, 13.2).
- **Contamination.** The coding tasks are familiar to models, so they measure competence at familiar work. The memory tasks use invented facts and cannot be contaminated (DESIGN 13.3).
- **The host-containment cut.** The agent's shell runs inside the worker container. The network is not controlled or recorded. All trials share 1 unprivileged user, and unit-test graders run agent-written code as root. The committed runs predate the unprivileged-user fix (DESIGN 13.6; STATE "Audit fixes (code)", Found 3 and 4).
- **The secondary experiment is fragile.** Model-a against model-b shows +0.106 [0.030, 0.197], but the 17 non-judged tasks give +0.078 [0.000, 0.176] (noise). The judge was grading its own model's answers there, and 3 of model-a's passes came from trials that read the grader file before that path was closed. Read it as **no reliable difference** (DESIGN 10.5).
- **Cost.** The figures are a floor: Hermes's retries carry no tokens, the provider route is not pinned, and the committed runs priced cached tokens at 0 (DESIGN 12.2, 13.14).
- **One run, one day, one route.** Reproduction re-runs the inputs, not the provider (DESIGN 13.7).

## The claim boundaries that must never collapse

| we can say | we cannot say |
|---|---|
| measured on 22 tasks | measured in general |
| a validated judge (kappa 0.64, interval 0.32 to 0.90) | a trusted judge, as a fact about the world |
| config B beat config A on this task set | config B is better |
| isolated between trials | contained from the host |
| a reproducible configuration (every input pinned by hash) | reproducible output |
| memory helped on tasks written to need memory | memory helps |
| no reliable difference between the 2 models | model-a is better |
| N = 3 met the pre-registered rule | N = 3 is enough for any question |
| the platform's cost figure, a floor | what it cost |
| the agent answered from memory the harness put in the prompt | the agent chose to use its memory |
