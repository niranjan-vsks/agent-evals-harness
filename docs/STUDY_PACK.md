# Study pack: the agent evaluation platform

Source material for study tools (podcast, explainer, flashcards, quiz). It is self-contained: everything needed is on this page.

## What this is about

A company wants to know whether a change to an AI agent really makes it better, or whether the improvement is luck. This project is a platform that runs agents on a fixed set of tasks, grades every run, and answers one question with a number and an error bar: does setup A beat setup B, or is the difference noise? It was built as a take-home assignment in 8 phases, and it ran 1 real experiment: does giving the agent a memory file help it?

---

## Glossary

**Harness.** Everything built around a language model that turns its text into actions: the loop, the tools, the memory, the skills, the prompts.
If the model is the driver, the harness is the car. This project has 2: Hermes Agent and a small loop written by the author.

**Model.** The language model itself, which only produces text and cannot act on its own.
This project uses 2, both reached through 1 service, OpenRouter: a small open model (gpt-oss-20b) and Claude Haiku 5.5.

**Task.** 1 job for the agent: a prompt, sometimes some files, and 1 or more rules that decide pass or fail.
There are 22, in 5 groups: memory-dependent, memory distractor, neutral deterministic, neutral judged, and honesty.

**Grader.** The rule that turns a finished run into pass or fail, such as an exact answer match, a file check, a hidden unit test, or a check of which commands the agent ran.
If a task has several graders, all of them must pass.

**Judge.** A grader that is itself a language model, used only where the output is prose, such as a summary or a commit message.
It reads only the final output and a fixed rubric, never the agent's steps, so it cannot reward verbosity.

**Config.** 1 harness plus 1 model plus 1 set of settings, such as tools, memory, temperature and step limit.
It is frozen once made: identical settings give back the same config, and different settings give a new one.

**Experiment.** 2 or more configs, a set of tasks, a number N, and a hypothesis written before the run.
The hypothesis is locked when the experiment starts, so it cannot be edited after seeing data.

**Trial.** 1 run of 1 config on 1 task.
It ends as a scored pass or fail, or as an infrastructure error that is retried and never scored.

**Trace.** The full written record of a trial: every message, tool call and result, memory read, the system prompt, and the final answer.
It is what you open to see why a trial failed.

**N.** How many trials are run for each task under each config.
The real experiment used N = 3, so 22 tasks times 2 configs times 3 gives 132 trials.

**Bootstrap.** A way to measure uncertainty by redrawing the data many times.
Here the 22 tasks are redrawn with replacement 10,000 times, and the spread of the answers gives the error bar.

**Confidence interval.** The range the true difference plausibly lies in, at 95 percent.
A difference of -0.333 with an interval of -0.515 to -0.167 means the true difference is very likely between those two numbers.

**Noise rule.** The platform calls a difference "noise" whenever the 95 percent interval contains 0, including when it just touches 0.
Only when the whole interval sits on one side of 0 does it name a winner. There is no minimum effect size.

**Kappa.** A measure of how well 2 graders agree, corrected for the agreement they would reach by luck.
1 is perfect agreement and 0 is chance. The platform trusts the judge at 0.6 or more, flags it from 0.4, and excludes it below 0.4.

**Isolation.** Keeping trials from affecting each other.
Each trial gets a fresh process, a fresh folder with copied files, and runs as an unprivileged user that cannot read the answers. It is isolation between trials, not containment from the host machine.

**Reproduction.** Re-running an experiment with exactly the same inputs, pinned by fingerprints (hashes).
The inputs are reproducible; the outputs are not, because models are not deterministic, and the error bar says how much they should move.

---

## Build timeline: 8 phases, in order

1. **Foundation.** The 4 containers (database, API, worker, web), the database schema, a worker that runs each trial in its own process, the Hermes adapter, 2 graders, and 1 trial end to end. Why: prove a single trial can run, be graded and be stored before building on it.
2. **Second harness and the task set.** The minimal loop, written only after the adapter contract was frozen; the remaining graders, including the judge; all 22 tasks; the judge labelling tools. Why: a harness that shares no code with Hermes is the test that the abstraction is real.
3. **Experiments and statistics.** The scheduler, retries, statuses, the paired bootstrap, the sign test, the comparison, exports, and the pilot that chooses N. Why: turn single trials into an answer with an interval.
4. **The web interface.** Screens for configs, experiments, comparison and trial inspection. Why: so a person can run and read it without the command line.
5. **The real experiment.** The pilot, the choice of N, 132 trials, the export, the judge sample, the README and the video script. Why: the deliverable is 1 real answer to 1 real question.
6. **Failure categories.** 12 ordered rules that label why a failed trial failed, such as running out of steps or abstaining. Why: "why it failed" is more useful than "it failed".
7. **Visual layer.** Dark and light themes, layout and readability, with no change to any logic. Why: the results must be legible on screen.
8. **Home dashboard.** The Overview screen and a read-only summary endpoint. Why: 1 page that shows everything at a glance.

After the phases: an independent audit, fixes from it (including the unprivileged user and pricing of cached tokens), and the author's 30 blind labels that validated the judge.

---

## The experiment in 10 sentences

1. The question was whether giving the Hermes agent a fixed memory file helps it, with the model and every other setting held fixed.
2. Config A had memory off; config B had memory seeded with a small file of 8 invented team facts, such as a staging database host.
3. The hypothesis, written and locked before the run, predicted a large gain on the 6 memory tasks and no change elsewhere.
4. A pilot of 3 trials per cell measured how much results vary, and the pre-registered rule said 3 trials were enough, not the 5 the design expected.
5. 132 trials ran in 29 minutes for 0.0775 US dollars including the judge, with no errors and no rate limiting.
6. Overall, memory off passed 0.561 and memory seeded 0.894, a difference of -0.333 with a 95 percent interval of -0.515 to -0.167, so seeded memory won.
7. On the 6 memory tasks the gap was almost total: 0 of 18 trials against 17 of 18.
8. On the distractor, neutral and honesty groups the intervals contained 0, which the platform reports as noise.
9. The judge that graded 5 prose tasks agreed with the author's blind labels at kappa 0.64, and replacing the judge with those labels left the winner unchanged.
10. A second experiment comparing 2 models showed no reliable difference, because its edge depended on the judge grading its own model and on a file leak since fixed.

---

## 25 flashcards

1. **Q:** What 2 things make up an AI agent? **A:** A model and a harness.
2. **Q:** Name the 2 harnesses. **A:** Hermes Agent and the minimal loop.
3. **Q:** Why write a second harness instead of adopting one? **A:** It shares no code with Hermes, so only the contract is common; that proves the contract.
4. **Q:** How many tasks are there? **A:** 22.
5. **Q:** What is N in the real experiment? **A:** 3 trials per task per config.
6. **Q:** How many trials did the real experiment run? **A:** 132.
7. **Q:** What single thing changed between config A and config B? **A:** Memory: off against seeded.
8. **Q:** What was the overall difference? **A:** -0.333, A minus B.
9. **Q:** What was its 95 percent interval? **A:** -0.515 to -0.167.
10. **Q:** Which config won? **A:** Seeded memory (B).
11. **Q:** What does a negative difference mean here? **A:** B, the seeded config, did better.
12. **Q:** When does the platform say "noise"? **A:** When the 95 percent interval contains 0.
13. **Q:** What is resampled in the bootstrap, tasks or trials? **A:** Tasks.
14. **Q:** When is McNemar's test used? **A:** Only when N = 1.
15. **Q:** What was the sign test result? **A:** A won 1 task, B won 11, 10 tied, p = 0.0063.
16. **Q:** How did memory-dependent tasks score? **A:** 0 of 18 trials with memory off, 17 of 18 seeded.
17. **Q:** What was the judge's kappa? **A:** 0.6377.
18. **Q:** What was kappa's 95 percent interval? **A:** 0.321 to 0.902.
19. **Q:** What policy did that kappa give? **A:** Trusted, because it is at least 0.6.
20. **Q:** Which task held most judge disagreements? **A:** The flaky-test diagnosis task, 4 of 5.
21. **Q:** Why did the pilot choose 3, not 5? **A:** Measured variance was 0.0606, a quarter of the worst case assumed.
22. **Q:** What does the pilot deliberately not show? **A:** The difference between configs.
23. **Q:** How is a trial isolated? **A:** Fresh process, fresh folder, unprivileged user, graded after it exits.
24. **Q:** What did the model-versus-model experiment conclude? **A:** No reliable difference.
25. **Q:** What did both experiments cost? **A:** 0.139 US dollars, a lower bound.

---

## The 5 hardest questions, with model answers

**1. Your memory tasks were written so that memory wins. Isn't the result circular?**
Partly, and deliberately. 6 tasks were written so that the answer exists only in memory; they test whether the harness actually puts memory to use. The other 16 tasks are the control: they should not move, and their intervals contain 0. The 2 distractor tasks test the failure mode where memory overrides an explicit instruction, and memory did not hurt there. So the honest claim is "memory helped on tasks written to need it, and did no harm elsewhere on this set", not "memory helps agents".

**2. Kappa's lower bound is 0.321, below your own exclusion line of 0.4. Why trust the judge?**
The rule, fixed before labelling, acts on the measured value, 0.6377, which is above 0.6. The interval is reported next to it because 30 items from 1 person is a small check. The disagreements are concentrated: 4 of 5 are on 1 task. And the headline does not depend on the judge: with the human labels in place of the judge's verdicts the difference is still -0.318 with interval -0.515 to -0.136.

**3. The memory interval is -1.000 to -0.833. Is the effect really that precise?**
No. The interval is narrow because all 6 memory tasks moved by about the same amount, so redrawing them always gives about the same average. It says the tasks agree. It does not say the effect on all memory-style work is 0.944. With 6 hand-written tasks, the result generalises only to tasks like them.

**4. You ran 3 trials where the design expected 5. Did you cut corners?**
The rule was written in advance: run a pilot at 3, measure the variance, take the smallest N whose projected error is at most 0.15. At temperature 0 most cells were all-pass or all-fail, so the variance was 0.0606 and 3 trials met the rule. The pilot endpoint cannot return the difference, so the choice could not be steered by the result. The cost: 3 trials resolve large effects only.

**5. Could the agent have cheated by reading the answer files?**
In the real experiment the trace shows it read the grader file 0 times in 132 trials. In the second experiment, the Claude model read it in 7 of 66 trials, which is one reason that experiment is reported as no reliable difference. After an audit, trials run as an unprivileged user that cannot read the answers, and a probe checks that before every trial. The remaining boundary is that this is isolation between trials, not containment from the host: the network is not controlled.

---

## The limits, in plain words

- **Small task set.** 22 tasks, 6 on memory. The result is about tasks like these.
- **Few trials.** 3 per cell. Small effects would be invisible; the smallest the headline could detect was about 0.17.
- **One judge, one labeler.** 30 labels from 1 person; no second person to check the labels themselves.
- **Contamination.** The coding tasks are familiar to models; the memory tasks use invented facts, so they cannot be memorised.
- **Not a sandbox.** Trials are kept apart from each other, but the agent's shell runs inside the worker container and the network is not controlled.
- **The second experiment is not reliable.** Its judge graded its own model, and some of its passes came from reading the grader file before that path was closed.
- **Cost is a lower bound.** Retried calls carry no tokens, the serving provider is not recorded, and the committed runs priced cached tokens at 0.
- **One run, one day, one provider route.** Re-running repeats the inputs, not the provider's behaviour.
- **Same inputs, different outputs.** Reproduction pins the inputs; the model's answers will differ, and the error bar says by how much.
