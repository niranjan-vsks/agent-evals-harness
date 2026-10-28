# SCRIPT.md

Word for word. Spoken text is in quote blocks. Cues are in square brackets. Mechanics and expected values are in DEMO_GUIDE.md; read every number off the screen, and if the screen differs, DEMO_GUIDE section 4 says what to do. This replaces VIDEO.md, which was drafted before the judge validation and uses a different failed trial.

## Time allocation

10:00 in all: **9:50 scripted, 0:10 of slack.** Start times are the target. If you are behind at 7:00, drop the design-document beat (9:00) and say its 1 line during the close; that recovers 20 s.

| start | section | length |
|---|---|---|
| 0:00 | Intro: who I am, and why this assignment fits | 0:30 |
| 0:30 | The result, in 1 breath | 0:15 |
| 0:45 | Deck: problem, architecture (7 steps), statistics, judge, result | 1:45 |
| 2:30 | Setup: 1 command, 4 containers | 0:15 |
| 2:45 | Overview | 0:45 |
| 3:30 | Configs: a refusal | 0:45 |
| 4:15 | Start the live run; the pilot | 0:45 |
| 5:00 | Compare | 1:45 |
| 6:45 | A failed trial and its twin | 1:00 |
| 7:45 | The code | 1:15 |
| 9:00 | The design document | 0:20 |
| 9:20 | The live result, and the close | 0:30 |
| 9:50 | end; 0:10 of slack remains | |

---

## 0:00 Intro (0:30)

[CAMERA ON if you are using it] [DECK: the Welcome slide on screen, do not advance yet]

> "Hi, I'm Niranjan. I'm a senior forward deployed AI engineer, 7 plus years building production AI systems, and the last 4 of those on agentic and GenAI systems end to end. I don't only build the agent. I own the harness around it: the evaluation, the observability, the quality bar it gets judged against. So when this assignment arrived, it was, honestly, a description of my job: take a harness and a model, change 1 thing, and answer whether the agent got better, worse, or stayed the same, and how sure we are."

[PAUSE 1s]

## 0:30 The result, in 1 breath (0:15)

[NEXT SLIDE: the question and the answer]

> "So I picked 1 such question to put the platform through. Does giving the agent a memory file make it better, or is the improvement luck? Here is what came out. On 22 tasks, Hermes with seeded memory passed 0.894 against 0.561 without it. That is a difference of minus 0.333, with a 95 percent interval from minus 0.515 to minus 0.167. The rest of this video is how the platform gets to that number, and where it stops trusting itself."

## 0:45 Deck (1:45)

[NEXT SLIDE: the problem]

> "The usual evidence for 'this change made the agent better' is 1 run and 1 score, with no error bar. Agents are not deterministic, so a single run cannot separate a real change from noise. This platform asks a narrower question: on the same tasks, does config A beat config B, and is the difference bigger than the noise?"

[PAUSE 1s] [NEXT SLIDE: architecture. The numbered badges appear in the order you say them; pace each step to its badge]

> "4 containers, and 1 cycle that every trial goes through. Step 1: in the interface I define a config, which is a harness plus a model plus settings. Step 2: the API turns an experiment into trials, every task under every config, N times each, and schedules them with retries. Step 3: the worker starts a fresh process for each trial, as an unprivileged user. Step 4: that process talks to the harness only through 1 adapter contract. 2 harnesses sit behind it: Hermes, and a small loop I wrote after freezing the contract, to prove the contract is not shaped like Hermes. Step 5: the harness calls the model through OpenRouter, so a model is a registry row. Step 6: when the agent exits, the graders run on what it left behind. Step 7: the trace, the token usage and the grades go back to the API, which is where the statistics live. Then the loop repeats for the next trial."

[NEXT SLIDE: the statistical approach, let it build]

> "Each task runs 3 times per config, which gives a pass rate per task. I take the difference task by task, so task difficulty cancels, average it, and resample the 22 tasks 10,000 times to get an interval. The rule is fixed in code: if the interval contains zero, the verdict is noise."

[NEXT SLIDE: the judge gate]

> "5 tasks produce prose, so a second model judges them. I labelled all 30 of those trials blind. Kappa came out at 0.64, with an interval from 0.32 to 0.90. That passes the 0.6 line I set beforehand, so the judged tasks count."

[NEXT SLIDE: the result, let the bars draw]

> "The result. Memory-dependent tasks: 0 of 18 trials without memory, 17 of 18 with it. Every other group contains zero. So the claim is narrow: memory helped on tasks written to need it, and did no harm on the rest of this set. That is the deck. Everything else is the running system, starting with how it comes up."

## 2:30 Setup: 1 command, 4 containers (0:15)

[SWITCH TO TERMINAL: the repo folder, `docker compose ps` already typed] [PRESS ENTER]

> "Setup is 1 command, docker compose up, with the API key in a dot env file. 4 containers: database, API, worker, web. The README covers adding a task, a harness and a model."

## 2:45 Overview (0:45)

[SWITCH TO BROWSER: http://localhost:8280/] [PAUSE 2s while the numbers count in]

> "This is the home screen. 3 experiments, 268 trials, none errored, 0.11 dollars of agent model spend, which is a floor. The best pass rate on the board is 0.894, and it belongs to the memory-seeded config."

[POINT: Latest verdicts]

> "Each stored comparison shows its interval and verdict. The memory experiment: seeded better, minus 0.333. The other row compares 2 models. It reads 'A better', but I treat it as no reliable difference: it leans on judged tasks graded by one of the models being compared, and on 3 trials that read a grader file before I closed that path."

[POINT: failure categories]

> "Every failed trial gets a cause from 12 ordered rules, with the evidence attached."

## 3:30 Configs: a refusal (0:45)

[CLICK: Configs]

> "A config is a harness, a model and its settings. It is immutable: the same settings return the same row, and a change makes a new one."

[CLICK: the create form] [TYPE name: minimal loop with skills] [SELECT harness: minimal_loop] [SELECT model: openai/gpt-oss-20b] [TOOLS: leave the defaults ticked] [MEMORY MODE: off] [SKILLS: tick enabled; preload empty] [TEMPERATURE 0, MAX_STEPS 15, MAX_OUTPUT_TOKENS 2048, TIMEOUT_SECONDS 300: leave as the form shows, change nothing] [CLICK: Create]

[PAUSE 2s on the refusal]

> "Refused, with the reason: the minimal loop has no skills. A harness never silently ignores a setting. If it cannot do exactly what the config says, the config is not created, so 2 configs with the same settings always mean the same thing."

[CLICK: Configs in the nav to leave the form. Do not create the config.]

## 4:15 Start the live run, and the pilot (0:45)

[CLICK: Experiments, then the create form] [TYPE Name: Live: memory off vs seeded] [TICK configs: hermes memory off first, then hermes memory seeded] [TASKS: untick all, then tick only det-06-ini and mem-05-lint] [SET N: 1] [SEED: leave empty] [PHASE: leave default] [TYPE Axis: memory off vs seeded, live] [TYPE Hypothesis: On these 2 tasks memory changes mem-05 only; with 2 tasks and 1 trial the platform should call it noise.]

> "The task list here is the full set from the repo: 22 small jobs with a checkable answer, like counting rows in a CSV, fixing a function until hidden tests pass, writing a commit message, running the team's lint the way the team runs it. 6 of them can only be solved with the team's memory file; those are the ones that discriminate. For this live run I tick just 2: 2 tasks, 2 configs, 1 trial each. Notice the form will not let me start without writing down what I expect to happen. And once I press Start, that prediction is locked; I cannot go back and edit it after seeing the results."

[CLICK: Create] [CLICK: Start]

> "That is 4 trials. The scheduler runs 2 at a time, each one in its own fresh process. It takes about a minute, so I will come back to it at the end."

[CLICK: the primary experiment, "P5 primary"] [SCROLL TO: Pilot panel]

> "For the real run I chose N with a pilot. The pilot shows the variance and projected interval widths, and deliberately no difference between configs, so the sample size cannot be steered by the answer. The rule asked for a half-width under 0.15. The measured variance gave 0.084 at 3 trials, so 3 it was."

## 5:00 Compare (1:45)

[CLICK: Compare, A = hermes memory off, B = hermes memory seeded]

[POINT: badges]

> "Badges before numbers: reliability complete, judge policy trusted, no rate-limited trials."

[POINT: axis]

> "It names what differs between A and B: the memory setting, nothing else."

[POINT: aggregate] [PAUSE 2s]

> "Delta is A minus B: minus 0.333, interval minus 0.515 to minus 0.167. The interval does not contain zero, so: B better. The minimum detectable effect is 0.174, which is the smallest difference this experiment could have seen."

[SCROLL TO: category cards]

> "The hypothesis was stated per category, so the statistics are too. Memory-dependent: minus 0.944. The interval is narrow because the 6 tasks agree, not because the effect is known to that precision. Distractors, neutral and honesty: all contain zero, all noise."

[SCROLL TO: sign test]

> "A second opinion: a sign test over tasks. B won 11, A won 1, 10 tied."

[SCROLL TO: per-task table]

> "Per task, labelled direction only: 3 trials against 3, no correction. The 0.33 rows outside memory are single trials."

[SCROLL TO: cost, latency, tokens]

> "Quality next to cost. Memory adds 1,136 tokens to every call, but the memory tasks finish in fewer calls, so per trial seeded was cheaper here. The cost interval contains zero."

## 6:45 A failed trial and its twin (1:00)

[SCROLL TO: per-task table, row mem-05-lint] [CLICK: the memory-off trial, 01M5SRTYYFKEFMG9GHK40QFHQQ]

> "A failure under memory off. The task: run the project's lint the way the team runs it. Category: wrong tool usage, with the evidence linked."

[POINT: the 2 graders]

> "2 graders. The answer: expected FAIL, got PASS. And the mechanism: no shell call ran lint with strict."

[SCROLL TO: timeline, event 6, then event 9]

> "It read lint.py, which shows a strict mode exists. Then it ran the plain command, got PASS, and reported PASS. The fact that the team runs it strict lives only in memory."

[CLICK: back] [CLICK: the seeded trial, 01M5SRTYYFKEFMG9GHK40QFHQR] [POINT: event 0]

> "Same task, memory seeded. The memory, loaded by the harness, says: lint is run as python lint.py --strict. 2 steps: it runs strict, gets FAIL, answers FAIL. The only difference between these 2 trials is the memory setting."

## 7:45 The code (1:15)

[SWITCH TO EDITOR: api/src/stats/compare.ts] [SCROLL TO: noiseRule]

> "3 files carry the idea. First, the noise rule. If the interval contains zero, rounded to 12 decimals, the verdict is noise. There is no minimum effect size and no other test overrides it."

[SCROLL TO: pairedBlock]

> "Above it, the paired block: per-task pass rates for A and B, bootstrapped over tasks with the experiment's stored seed, so the same data always gives the same interval."

[SWITCH TO: worker/adapters/base.py] [SCROLL TO: class HarnessAdapter]

> "Second, the contract. A harness implements 4 methods: validate, prepare, run, collect memory. Validate is what refused the config earlier. Adding a harness is 1 directory and 1 registry line, and the same conformance suite runs over both harnesses."

[SWITCH TO: worker/runner.py] [SCROLL TO: _run_in_dir]

> "Third, isolation. Each trial gets a fresh directory and a fresh child process, running as an unprivileged user. Its copy of the spec has the graders removed, and the runner grades only after the child exits. That is isolation between trials. It is not a sandbox from the host: the network is not controlled."

## 9:00 The design document (0:20)

[SWITCH TO EDITOR: DESIGN.md, markdown preview] [SCROLL TO: section 9.7, the N table]

> "The design document carries the reasoning: the N formula and the pilot rule here in section 9.7, the pre-registered hypothesis in 10.1, the measured result in 10.4."

[SCROLL TO: section 13]

> "And section 13 is the known limits, written before the run, not after."

## 9:20 The live result, and the close (0:30)

[SWITCH TO BROWSER: the live experiment] [CLICK: Compare]

> "The live run finished. mem-05 flipped and det-06 did not. With 2 tasks and 1 trial each, the interval reaches zero, and the platform says noise. The same rule that called the real experiment calls this one too small."

[PAUSE 1s]

> "The limits, because they matter as much as the result: 22 tasks, 3 trials per cell, 1 model, 1 day. The judge is validated against 1 labeler. The memory result holds on tasks written to need memory, and DESIGN section 13 lists the rest."

[PAUSE 1s] [CAMERA, if on]

> "That is the harness I would want around any agent I ship: it tells you what changed, it tells you how sure to be, and it tells you when to stop believing it. Thanks for watching. I'd be glad to walk through any part of it."

[STOP RECORDING]

---

## Banned phrases

Do not say any of these, even as a joke.

| banned | why | say instead |
|---|---|---|
| "production ready" | it is a take-home with listed limits | "the deliverable, with its limits in DESIGN 13" |
| "zero false positives" | not measured | "the noise rule is tested on both sides of the boundary" |
| "this proves the model is better" (or "model-a is better") | the secondary is fragile | "no reliable difference" |
| "memory helps" or "memory makes agents better" | measured on 6 tasks written to need it | "memory helped on tasks written to need it" |
| "significant" for any row whose interval contains 0 | the noise rule says otherwise | read the verdict on screen |
| "the judge is accurate" or "the judge is reliable" | kappa 0.64 with interval 0.32 to 0.90, 1 labeler | "validated, kappa 0.64, interval 0.32 to 0.90" |
| "sandboxed", "secure", "contained" | the agent's shell runs in the worker container; the network is not controlled | "isolated between trials" |
| "fully reproducible" or "deterministic" | outputs differ run to run | "the configuration is reproducible; the output is not" |
| "the effect is exactly 0.944" | a narrow interval means the tasks agree | "the 6 tasks agree" |
| "the cost was X" without "at least" | it is a floor | "the platform's figure, a floor" |
| "N = 3 is enough" | it met the rule and resolves large effects only | "N = 3 met the pre-registered rule" |
| "I didn't cheat", "this isn't cherry-picked", "nothing is hard-coded" | defensive denial of something nobody said | show the evidence and move on |
| "obviously", "clearly", "simply" | false confidence on camera | nothing |
| "general", "always", "in all cases" | measured on 22 tasks, 1 model, 1 day | "on this task set" |
| "the minimal loop is worse than Hermes" | no harness experiment was run | "the minimal loop proves the contract" |
