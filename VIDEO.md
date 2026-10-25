# VIDEO.md: script for the walkthrough recording (10 minutes at most)

Tool-agnostic. One take, screen plus voice. The times are where each section starts; the last section ends at 10:00 at the latest, so the recording stays under the limit only if each section keeps to its slot. Time them on the dry run.

## Before you press record

1. **Use the stack that ran the experiment**, not a fresh `docker compose up`: a fresh database is empty, and the platform has no import endpoint (the committed export is the record, not a restore point). The experiment lives in the compose project `p5run`. If Docker Desktop is closed, open it, then:

   ```
   set DOCKER_BUILDKIT=0 & set COMPOSE_BAKE=false
   docker compose -p p5run -f C:\hx\p5src\docker-compose.yml up -d
   docker compose -p p5run -f C:\hx\p5src\docker-compose.yml ps     # db, api, worker, web healthy
   ```

   The UI is then at <http://localhost:8280>. Never run `down -v` on that project: it deletes the volume that holds the experiment. `experiments/p5/README.md` explains how that stack was made and how to rebuild it.
2. Record **after** `labels.jsonl` is committed and `npm run judge:kappa` has run, and after `experiments/p5/fetch-results.mjs` has been run again, so the Compare page shows the final judge policy and 22 tasks (or the "excluded" badge, if kappa came out below 0.4). Read every number off the screen; do not read them from this file. DESIGN.md 10.4 is the cheat sheet.
3. Browser: 1 tab, window about 1400 px wide, zoom 100 percent, no bookmarks bar. Keep DESIGN.md 10.4 open in another window for yourself, not on screen.
4. Have the 3 ids ready to paste: the experiment `01M5SRTYPNZ9EWV1HX8KJGX40N`, the failed trial `01M5SRTYYFKEFMG9GHK40QFHQF`, the passing seeded trial `01M5SRTYYFKEFMG9GHK40QFHQG`.
5. Do a dry run of 2:30 to 4:30 (the live experiment) once, so the first load is warm. It costs about 0.001 USD.

## 0:00 The problem, and the architecture in one line

*Screen: the README top in a browser or editor, then the architecture sketch.*

> "People say an agent harness or a model change made their agent better. Usually it is one run, one score, no error bar. This platform asks a narrower question: does config A beat config B on the same tasks, and is the difference larger than the noise? It answers with a number and an interval, and it says 'noise' when the interval contains zero.
>
> The shape is 4 containers. A Vue UI. A NestJS API with PostgreSQL that owns experiments, scheduling and the statistics. A Python worker that runs each trial in its own process through a harness adapter and grades it. And the models, all through OpenRouter. There are 2 harnesses behind 1 adapter contract, Hermes Agent and a small loop I wrote after the contract was frozen, which is the check that the abstraction holds."

## 1:00 Create a config, and show a refusal

*Screen: Configs page, `http://localhost:8280/configs`.*

1. Say: "A config is a harness, a model and settings, and it is immutable. The same settings give the same row back; a change gives a new one."
2. Pick harness `minimal_loop`, model `openai/gpt-oss-20b`, **skills enabled**, and submit.
3. The red box appears: **"config refused: the harness cannot honor these settings exactly"** with the reason "the minimal loop has no skills; skills.enabled must be false". Point at it.
4. Say: "This is the rule that keeps comparisons honest. A harness never silently ignores a setting. If it cannot do exactly what the config says, the config is not created, so 2 configs with the same label never mean different things."
5. Untick skills, submit, show "created config ...". Say: "The row carries a hash over harness version, model and every setting."
6. Open the 2 real configs in the list (`hermes memory off`, `hermes memory seeded`) and point at the one setting that differs, memory.

## 2:30 Create an experiment, write the hypothesis, start it, watch it

*Screen: Experiments, then New experiment.* To keep the video short this is a small live run, 4 tasks and 1 trial each, about 2.5 minutes of wall time on a warm stack. The real experiment is shown from 4:30.

1. Pick the 2 Hermes configs. Tick only `det-06-ini`, `mem-01-staging-db`, `mem-02-owner`, `dis-01-json`. N = 1.
2. In the hypothesis box type: "Memory helps on memory tasks and is noise elsewhere." Say: "The hypothesis is required, and it is frozen when the experiment starts. The platform will not let me edit it after I have seen data."
3. Create, then Start. Narrate the progress line while it runs: "8 trials, 2 at a time. Each trial is a fresh process with its own directory; the page polls the API."
4. While waiting, open the experiment list and point at the real experiment `01M5SRTYPNZ9EWV1HX8KJGX40N`: 22 tasks, 2 configs, 3 trials each, 132 trials, completed, 0 errored. Say: "That one ran in 29 minutes for under 8 cents."
5. Open the real experiment's page. Point at the **Pilot panel**: "Before choosing how many trials to run, I ran 3 per cell and asked the platform for the variance. The pilot endpoint returns variances and projected interval widths and deliberately no delta, so the sample size is chosen without looking at the answer. The rule picked 3."

## 4:30 Compare

*Screen: the real experiment, Compare picker, then the Compare page.* Take your time here; it is the core of the video.

1. **Badges first.** "Before any number: reliability, which says whether every trial finished; the judge policy; and how many trials were rate limited. If the judge had not been validated, the tasks it grades would be removed, and the badge says so."
2. **Axis label and config diff.** "It tells me what differs between A and B: settings only, memory. If 2 or more axes differed it would say the difference is not attributable."
3. **Aggregate.** Point at the delta, its interval and the sentence. "The delta is A minus B with a 95 percent bootstrap interval over tasks. The verdict is 'noise' exactly when the interval contains zero." Read the verdict sentence as the page shows it; if it says noise, say that this is the method working, not a failure. Read the min-detectable value: "That is the smallest effect this experiment could have seen."
4. **4 category cards.** "The hypothesis was stated per category, so the statistics are too. Memory-dependent tasks: if every task moves by the same amount the interval has no width; that says the tasks agree, not that the effect is exactly that size. Then the others: say whether each contains zero."
5. **Sign test and per-task table.** "A sign test over tasks as a second opinion. The per-task table is labelled direction only: 3 trials against 3, no correction."
6. **Cost, latency, tokens.** "Quality next to cost. Memory adds a block to every call, but the memory tasks finish in fewer calls, so per trial the seeded config was cheaper overall and dearer on the tasks memory does not help."
7. If the judge policy badge is not "excluded": "The 5 judge-graded tasks are in because the judge agreed with my own labels on 30 blind items; kappa is on the page."

## 7:00 A failed memory-dependent trial under memory off

*Screen: the trial `01M5SRTYYFKEFMG9GHK40QFHQF`, from the experiment's trial table (filter task `mem-01-staging-db`, config memory off).*

1. First screen: **FAIL**, exit reason `max_steps`, 15 steps. "Why it failed: the grader expected `pg-stage-07.internal:6432` and extracted `unknown:unknown`."
2. Open the timeline. "No memory event. The system prompt, in the closed section at the bottom, does not contain the host." Expand a few `search_files` calls: "It searched for staging, database, DB_HOST, DATABASE_URL, env files, and found nothing, because the fact exists only in the team's memory."
3. Point at the last line of the final response, `FINAL: unknown:unknown`. "It did not invent a host. It ran out of steps saying it did not know."

## 8:30 The same task under memory seeded

*Screen: the trial `01M5SRTYYFKEFMG9GHK40QFHQG`.*

1. First screen: **PASS**, 1 step. Timeline: the 2 `memory_read` events at the top, `MEMORY.md` and `USER.md` (expand one: its data says `loaded_by: harness`, so the harness put it in the prompt, the agent did not fetch it). Point at "Staging database: host pg-stage-07.internal, port 6432".
2. "The memory is in the prompt before the agent acts, so it answers in one call: `FINAL: pg-stage-07.internal:6432`. The only difference between these two trials is the memory setting, which is the point of a single-axis experiment."
3. Optional, 20 seconds: open `dis-02-owners-file` seeded, show that memory says billing is Priya, the file says Sam, and the agent answered Sam.

## 9:30 Limits, in 2 sentences

*Screen: DESIGN.md section 13, or the Compare page.*

> "22 tasks, 6 of them on the memory axis, 3 trials per cell, 1 model, 1 day and 1 OpenRouter route; the memory interval is as narrow as it is because every memory task agrees, and the 2-task groups only resolve large effects. The judge is checked against 30 labels from a single labeler, Hermes's own retries are not in the cost totals, and the provider behind the model slug is not pinned, all recorded in DESIGN.md section 13."

*End on the Compare page or the README table of contents. Stop recording by 9:55.*

## Timing check (gate 4 of cards/P5.md)

Run the script once end to end with a timer and write the duration in STATE.md: it has not been timed yet.
