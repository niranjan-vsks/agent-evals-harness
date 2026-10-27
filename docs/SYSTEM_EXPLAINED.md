# SYSTEM_EXPLAINED.md

What we built, and why, in plain language. Read the first part once to get the whole picture. The rest is organised around the decisions you will be asked to defend.

Every number has its source next to it. "DESIGN 10.4" means section 10.4 of DESIGN.md. "STATE P8" means the P8 section of STATE.md.

---

## Part 1. The whole picture (1 page)

### What the assignment asked

The company wants evidence, not impressions. In the assignment's words: build a platform that evaluates any harness running with any model, and answers with evidence whether one setup is better than another. It also asked for 1 real experiment that changes a single thing, a judge that is shown to be trustworthy, isolated runs, confidence intervals, a README, a design document and a video.

### What an agent is made of

| part | what it is | example in this build |
|---|---|---|
| **model** | the language model that writes text. It cannot open a file or run a command by itself | `openai/gpt-oss-20b` (called `model-b`), `anthropic/claude-haiku-5.5` (called `model-a`), both reached through OpenRouter |
| **harness** | everything around the model that turns text into actions: the loop, the tools, the memory, the skills, the prompts | Hermes Agent, and our own `minimal_loop` |

Analogy: the model is the driver, the harness is the car.

### The 2 harnesses

| harness | what it is | why it is here |
|---|---|---|
| **Hermes Agent** | an open-source agent from Nous Research, pinned at commit `f4ac0bea1e`, installed inside the worker image, not copied into the repo (STATE 0) | the assignment requires it |
| **minimal_loop** | a small tool-calling loop we wrote ourselves, about 413 lines (DESIGN 11.16), written only after the adapter contract was frozen (DESIGN 3) | it is the test that our abstraction is real. If a harness that shares 0 lines with Hermes fits the same contract, the contract is not secretly shaped like Hermes |

The minimal loop is not a competitor to Hermes. It is a second plug for the same socket.

### The words you need first

| word | plain meaning |
|---|---|
| **task** | 1 job for the agent: a prompt, maybe some files, and the rule that decides pass or fail. There are 22 (DESIGN 7.2) |
| **config** | 1 harness + 1 model + 1 set of settings (tools, memory, temperature, step limit, and so on). Frozen once created |
| **trial** | 1 run of 1 config on 1 task. It ends as pass or fail (or as an error that is not scored) |
| **N** | how many trials we run for each (task, config) pair. The primary experiment used **N = 3** (DESIGN 10.4) |
| **experiment** | 2 or more configs, a set of tasks, and N. 22 tasks x 2 configs x 3 = **132 trials** |

Why N matters: a model gives different answers on different runs. 1 run per task tells you almost nothing. With 3 runs per task, each task gets a pass **rate** (0, 0.33, 0.67 or 1), not a single coin flip.

### What each of the 8 phases built

| phase | what it built | why |
|---|---|---|
| **P1** | the 4 containers, the database schema, the worker that runs 1 trial in its own process, the Hermes adapter, 2 graders, 1 trial end to end | prove 1 trial can run, be graded and be stored before building anything on top |
| **P2** | the minimal loop, the other graders (unit tests, trace checks, the LLM judge), all 22 tasks, the judge labelling tools | the second harness tests the contract; the task set is what the experiment runs on |
| **P3** | experiments, the scheduler, retries, statuses, the statistics, the comparison, exports, the pilot | turn single trials into an experiment with an answer and an interval |
| **P4** | the Vue web UI: configs, experiments, compare, trial inspector | so a person can run and inspect it without curl |
| **P5** | the real experiment, the judge validation sample, README, results, video script draft | the deliverable: 1 real answer to 1 real question |
| **P6** | failure categories: 12 rules that label why a failed trial failed | stretch goal: "why did it fail", not just "it failed" |
| **P7** | the visual layer of the UI (dark and light theme, layout, no logic change) | readability on camera |
| **P8** | the home screen, called **Overview**, and 1 read-only summary endpoint | 1 page that shows everything at a glance |

After P8: an independent audit (`audit/AUDIT_REPORT.md`), code fixes from it (STATE "Audit fixes (code)"), then the owner's 30 labels and the kappa (STATE "Judge validation").

### What each screen shows

| screen | what you see |
|---|---|
| **Overview** (home, `/`) | 6 totals, the latest stored verdict of each experiment, pass rate per config, cost against pass rate, failure categories, recent experiments |
| **Configs** | every config; a form to make one. A setting the harness cannot honor is refused with the reason |
| **Experiments** | the list, and a form to create one with a required hypothesis |
| **Experiment detail** | the hypothesis, progress, the pilot panel, every trial |
| **Compare** | badges first (reliability, judge policy, rate limits), then the delta with its interval and verdict, the 4 category blocks, the sign test, a per-task table, failure categories, cost and latency and tokens |
| **Trial** | pass or fail, why it failed, every grader result, the event timeline (each tool call with its result), memory before and after, the system prompt |

### The result, in 2 sentences

On 22 tasks, Hermes with seeded memory passed 0.894 against 0.561 with memory off, a delta of -0.333 with a 95 percent interval of [-0.515, -0.167], so the verdict is "seeded better" (DESIGN 10.4). Almost all of that comes from the 6 tasks written to need memory (0 of 18 trials against 17 of 18); everywhere else the difference is noise.

---

## Part 2. The system's vocabulary, as implemented

| term | as implemented | where it differs from the assignment's wording |
|---|---|---|
| **task** | a JSON file in `tasks/`, optional fixture files, 1 or more graders that must all pass. Versioned by a hash over the JSON and every fixture byte (README "Add a task") | same idea. An edited task is a new version; old experiments keep the version they pinned |
| **grader** | the rule that turns a finished trial into pass or fail. 5 types: `exact_match`, `file_state`, `unit_test`, `trace_check`, `llm_judge` (DESIGN 7.3) | the assignment says "deterministic graders" and "LLM-as-judge". `trace_check` is extra: it checks how the agent got there (for example that it ran `--strict`) |
| **config** | harness + model + settings, stored with a hash, immutable. The same settings return the same row (README "Using it") | the assignment says "versioned". We do it by making configs content-addressed and unchangeable rather than by version numbers |
| **experiment** | configs + tasks + N + a hypothesis that is frozen when it starts (DESIGN 10.1, D-10) | the assignment says "experiment" too; the frozen hypothesis is our addition |
| **trial** | 1 run of 1 config on 1 task, index 0 to N-1. A retried trial has several **attempts**; only the last one is scored (DESIGN 6.3) | the assignment says "run" or "trial". "Attempt" is ours |
| **trace** | the written record of a trial: every message, tool call and result, memory read and write, the system prompt, the final response | the assignment says "trial inspection"; the trace is what the inspector shows |
| **comparison** | the computed answer for config A against config B in 1 experiment: delta, interval, verdict, categories, per-task rows. When stored it is a `comparison_run` | the assignment says "compare configs". A stored comparison carries the seed and the stats version so it can be recomputed |
| **memory `seeded`** | the harness starts every trial with the same fixed memory files (`team-memory-v1`); nothing a trial writes reaches the next trial (DESIGN 6.1) | the assignment says "memory on vs off". "On" here means a fixed seed, not memory that accumulates |

---

## Part 3. The decisions

Each decision: what we chose, the alternatives, why, and what it costs.

### Decision 1. Paired bootstrap over tasks, not McNemar

**What we chose.** For config A against config B, compute each task's pass rate under A and under B, take the difference per task, and average over tasks. Then resample the 22 tasks with replacement 10,000 times (seeded) and take the 2.5th and 97.5th percentiles as the 95 percent interval (DESIGN 9.3).

**Plain words.** "Paired" means both configs ran the same tasks, so we compare task by task and the difficulty of each task cancels out. "Bootstrap" means: pretend our 22 tasks are a sample, redraw that sample many times, and see how much the answer moves.

**Alternatives.**
- **McNemar's test.** Needs exactly 1 pass/fail per task per config. With N = 3 we have a rate, not a single outcome, so McNemar would throw away information or force an arbitrary pairing of trial 1 with trial 1 (DESIGN 9.2). We still compute it, but only when N = 1 (DESIGN 9.5).
- **Resample trials instead of tasks.** Wrong unit: trials within a task are alike, tasks are not, and the question is about tasks (DESIGN 9.3).
- **A t-test.** Assumes a shape of distribution that 22 rates between 0 and 1 do not have.

**What the choice depends on.**
- N greater than 1, so each task has a rate.
- The tasks being a fair sample of the kind of work you care about. The interval is about "tasks like these 22", not all tasks.
- Enough tasks per group. With 2 or 3 tasks the interval is just the smallest and largest task delta; with 1 task there is no interval, and the code says `insufficient_data` (DESIGN 9.4, `MIN_PAIRED_TASKS = 2`).

**What it costs.** Small groups give coarse intervals: the 2-task groups can only take a few values (DESIGN 13.10). A group where every task moved by the same amount gets an interval of width 0, which means "the tasks agree", not "the effect is exactly this size" (DESIGN 10.4).

**The second opinion.** An exact sign test over tasks: count tasks A won, tasks B won, drop ties. Primary: A won 1, B won 11, 10 tied, p = 0.0063 (DESIGN 10.4).

### Decision 2. How N was chosen, and why it ended at 3

**The rule (written before the run, DESIGN 9.7).** Run a pilot at N = 3. Measure how much pass rates vary within a task. Project the interval half-width h(N) for larger N. Pick the smallest N with h(N) at most 0.15, capped at 8.

**The key safeguard.** The pilot endpoint returns variances and projected widths only, and **no delta**, so N is chosen without seeing the answer (DESIGN 9.7; audit F confirms the payload has no delta).

**What happened (DESIGN 10.4, STATE P5).**

| | value |
|---|---|
| within-task variance s2, measured | 0.0606 |
| the worst case the design assumed | 0.25 |
| h(3) with the measured variance | 0.0840 |
| rule threshold | 0.15 |
| chosen N | **3**: the pilot became the full run |

**Why not the expected 5.** The design expected N = 5 because it used the worst-case variance. At temperature 0 most task cells are all-pass or all-fail, so the real variance was about a quarter of the worst case, and the rule says trust the pilot (STATE P5 "N decision").

**What it costs.** h(N) only covers noise within a task. The spread between tasks is not reduced by N, which is why the real aggregate interval ([-0.515, -0.167], min detectable 0.174) is wider than 0.084. N = 3 resolves large effects only (DESIGN 13.10). It saved 88 trials (132 instead of 220).

**Small deviation to know.** The code tries every whole number from 3 to 8, not only {3, 5, 8}; both give 3 here (DESIGN 9.7 "changed in build").

### Decision 3. The experiment axis: memory, not model, not harness

**What we chose.** Hold harness (Hermes) and model (`gpt-oss-20b`) fixed and change exactly 1 setting: memory `off` against memory `seeded` with `team-memory-v1` (DESIGN 10.1).

**Why.** A difference can only be attributed to 1 thing when only 1 thing changes (DESIGN 1). Memory is something the company asks about, and it can be designed for: 6 tasks need facts that exist only in the memory file, 2 tasks test that memory does not override instructions, 14 tasks should not care (DESIGN 7.2). That gives a built-in control group.

**The ones we did not choose as primary.**
- **Harness against harness (Hermes against minimal loop).** Not run as an experiment. Hermes has its own retries, auxiliary calls, no seed parameter, and possibly sticky provider routing; the minimal loop has none of these, so the comparison would mix many differences (DESIGN 13.5).
- **Model against model.** Ran as a secondary experiment (DESIGN 10.5) because there was budget. Its result is fragile (below).
- **"Persistent" memory** (trial 1's writes reach trial 2) was rejected: it makes trials depend on each other and on scheduling order, which breaks what the bootstrap assumes (DESIGN 6.1).

**What it costs.** The memory result is about tasks written to need memory. It does not say memory helps in general.

### Decision 4. The second harness was written, not adopted

**What we chose.** Write `minimal_loop` ourselves after freezing the adapter contract, instead of wrapping an existing framework.

**Why (DESIGN 3).** It shares 0 lines with Hermes, so the only thing the 2 adapters share is the contract. A framework adapter would have tested how well that framework's habits map onto ours, not whether the contract holds. It is also a floor: Hermes's memory and skills are legible next to a loop that has none of its extras.

**Proof it worked.** The conformance suite, which runs every registered adapter against a scripted fake model server, runs unchanged over both (audit section I). Adding a harness is 1 directory plus 1 registry line; adding a model is 1 JSON row (README).

**What it costs.** It is a toy harness, not a product. 413 lines, not the planned 150 (DESIGN 11.16). Every place the contract had to change is listed in DESIGN 11.

### Decision 5. Per-trial directories and an unprivileged user, not a container per trial

**What we chose.** Each trial attempt gets a fresh child process, a fresh directory with a copy (never a link) of the fixture files, and for Hermes a fresh home directory (DESIGN 6.1). Since the audit fix `e73e939`, the child runs as an unprivileged user called `agent`; the task files with the answers sit under a root-only directory, and the trial's output folder is root-only. The runner, as root, grades after the agent has finished (STATE "Audit fixes (code)", ADAPTERS R-11).

**Alternatives.**
- **A Docker container per trial.** Strongest separation, but the worker would need to start containers from inside a container (Docker-in-Docker or the host's Docker socket), which the build rules forbid (STATE 0: "no Docker-in-Docker").
- **A mount namespace or a separate user per trial.** Not built (STATE "Audit fixes (code)", Cut on purpose).

**Why.** It gives what the assignment asked: no leak between trials unless memory says so. It is testable: a test sends an agent looking for the answers and checks it gets "Permission denied" (STATE "Audit fixes (code)", Verified).

**What it costs (the boundary).**
- All trials share 1 `agent` user. A trial that learns another trial's id could reach its workspace (STATE "Audit fixes (code)", Found 3).
- Graders run agent-written code as root (unit tests) (Found 4).
- The network is not controlled or recorded (DESIGN 13.6).
- The committed experiments ran **before** this fix. In the secondary experiment, 7 of 66 `claude-haiku-5.5` trials read the file that held the graders (DESIGN 10.5). The primary experiment read it in 0 of 132.

So the claim is "isolated between trials", never "contained from the host".

### Decision 6. The judge validation threshold, and what happens below it

**What the judge is.** For 5 tasks the output is prose (a summary, a commit message, a docstring, a flaky-test diagnosis, a release checklist). A second model (`model-a`) grades it against a fixed rubric. It sees only the final output and named files, never the agent's steps, so it cannot reward verbosity (DESIGN 8.1).

**How we checked it.** The owner labelled 30 judge-graded trials blind (no verdict, no config visible), applying the rubric literally. Then `npm run judge:kappa` compared the labels to the judge (DESIGN 8.2, 10.4).

**Kappa, in plain words.** Agreement that is corrected for luck. 2 graders who both say FAIL most of the time agree often by accident; kappa removes that. 1 is perfect, 0 is chance.

**The thresholds, fixed before labelling (DESIGN 8.3).**

| kappa | policy | effect |
|---|---|---|
| 0.6 or more | `trusted` | judged tasks count in the headline |
| 0.4 to below 0.6 | `flagged` | they count, with a "low confidence" badge |
| below 0.4, or no validation at all | `excluded` | judged tasks are removed from the headline and shown apart |

**The result (DESIGN 10.4).** 25 of 30 agree (0.8333), kappa **0.6377**, 95 percent interval **[0.321, 0.902]**, policy **trusted**. 4 of the 5 disagreements are on 1 task, `jdg-04-flaky`.

**What it costs.** The interval's lower end is below 0.4: 30 items from 1 labeler cannot rule out a judge that should have been excluded. The code decides on the point estimate. There is no second human, so there is no human-to-human ceiling (DESIGN 8.3, 13.2). Replacing the judge's verdicts with the human labels leaves the headline at B better (-0.318 [-0.515, -0.136]) (DESIGN 10.4).

---

## Part 4. The life of 1 trial

1. The API scheduler picks a pending trial, at most 2 at a time (`MAX_CONCURRENT_TRIALS`), writes an attempt row and copies the model prices into the trial (DESIGN 2.3).
2. It sends the trial spec to the worker over HTTP.
3. The worker makes a fresh directory, copies the fixture, checks the task hash, and starts a child process as user `agent`.
4. The child runs the harness adapter: `prepare`, `run` (events written to disk as they happen), `collect_memory`.
5. The runner, as root, collects the events and result, copies hidden test files in, runs the graders, and deletes the directory.
6. The API stores the trace and grader results, assigns a failure category if it failed, and updates the experiment's status.

If the provider rate-limits (HTTP 429) or errors (5xx), the trial is retried later (30 then 60 seconds, up to 3 attempts). If the agent runs out of steps or time, that is a scored failure, because it is the agent's behaviour (DESIGN 6.3).

---

## Part 5. The 5 things you would struggle to explain if asked suddenly

### 1. "Why is the memory interval so narrow, [-1.000, -0.833]? Is the effect really almost exactly 1?"

No. 5 of the 6 memory tasks moved from 0 to 1, and the sixth (`mem-06`) moved by 0.667. When every task in a group moves by about the same amount, resampling those tasks always gives about the same average, so the interval is narrow. It says **the 6 tasks agree**, not that the effect in all memory-type tasks is 0.944 (DESIGN 10.4, H1). And these tasks were written so that the answer exists only in memory.

### 2. "Kappa's interval goes down to 0.321. Why do you call the judge trusted?"

The policy was fixed before labelling and follows the point estimate, 0.6377, which is above 0.6. I report the interval next to it because 30 items from 1 labeler is a small check. Two facts make it safe for the headline: the disagreements sit on 1 task (`jdg-04-flaky`, 4 of the 5), and if the human labels replace the judge entirely the headline stays B better at -0.318 [-0.515, -0.136] (DESIGN 10.4). The right word is "validated, kappa 0.64 with interval 0.32 to 0.90", not "accurate".

### 3. "The design said N = 5. You ran 3. Did you cut corners?"

The rule written before the run was "pilot at 3, then the smallest N whose projected half-width is at most 0.15". The pilot measured a within-task variance of 0.0606, a quarter of the worst case, so h(3) = 0.084 met the rule. The pilot endpoint never showed the delta, so the choice could not be steered by the result (DESIGN 9.7, 10.4). The cost is stated: N = 3 resolves large effects only (DESIGN 13.10).

### 4. "The Overview says model-a is better than model-b. Why do you say no reliable difference?"

The stored verdict is A better, +0.106 [0.030, 0.197]. It rests on 2 weak legs. (1) It is carried by judged tasks, the judge is model-a grading its own answers, and the judge was never validated on model-a's outputs. (2) 3 of model-a's passes came from trials that read the file holding the graders, before the isolation fix. Without the judged tasks the interval's lower end is exactly 0 (noise); with those 3 trials scored as failures it is +0.061 [0.000, 0.136], noise (DESIGN 10.5). So: no reliable difference.

### 5. "Why does the same config show 2 different pass rates?"

The Overview's pass rate for a config pools every done trial of that config across every experiment. `hermes memory off` ran in both experiments (132 trials), so the Overview shows 0.568. The primary Compare page uses only that experiment's 66 trials and shows 0.561 (computed from the 2 committed exports; STATE P8 Found 1). Before kappa the gap was larger (0.568 against 0.667) because Compare then withheld the judged tasks. The caption under the chart explains the judge part; the pooling part is what applies now.
