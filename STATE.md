# STATE.md

What is built, verified, cut and left open. 1 section per phase, newest first. Written
after the fact by the session that built the phase. When this file and a card disagree
about what exists, this file wins (the card is authoritative only for what is not yet
built). `FORGE_RESUME.md` is the per-session resume scratch written at pre-compact; it is
gitignored and never the record. This file is.

Each phase section has exactly these headings: Shipped, Verified (with the N of N
numbers and the mutation test), Cut on purpose, Found but not fixed, Assumptions
resolved (A-ids with outcome), Next action.

---

## 0. Orientation (read in 30 seconds)

**What this is.** A take-home: a platform that evaluates any agent harness running with
any model and says whether config A beats config B with confidence intervals. The
assignment PDF is the authority; DESIGN.md is the design; ADAPTERS.md is the frozen
adapter contract; DATA_MODEL.md is the schema with named invariants; `cards/P1..P6.md`
are the build order, 1 phase each, P6 is cuttable stretch.

**Stack (fixed by the assignment).** NestJS + Prisma + PostgreSQL 16 (`api/`), Vue 3 +
TypeScript + Vite (`web/`), Python 3.14 worker with FastAPI (`worker/`) that runs the
harnesses and graders. `docker compose up` brings up `db`, `api`, `worker`, `web`. Keys in
`.env` (`OPENROUTER_API_KEY`). Models are reached through OpenRouter only.

**Harnesses.** Hermes Agent (required), not vendored: cloned at
`https://github.com/NousResearch/hermes-agent.git` commit
`f4ac0bea1ea50bba62886fb0b7e308e4edee8fd3` inside the worker image, `pip install -e`. A
local checkout for reading is at `../hermes-agent`. Second harness: `minimal_loop`, a
~150-line tool-calling loop written after the contract was frozen.

**Primary experiment.** Hermes, 1 fixed model, memory `off` vs memory `seeded` with
`tasks/memory/team-memory-v1`. Paired bootstrap over 22 tasks, N chosen by a 3-trial
pilot (expected 5). Verdict is "noise" iff the 95 percent CI contains 0.

**Layout.** `api/ web/ worker/ tasks/ experiments/ cards/` plus the 4 documents and
this file. See DESIGN.md 2.4.

**Rules that trip cold sessions.** Configs are immutable (D-3); tasks are versioned by
hash (D-2, D-6); never set an experiment `completed` with an errored trial (D-8); the
adapter contract is frozen (ADAPTERS.md, changes go in DESIGN.md 11); no Docker-in-Docker;
no em-dashes in documents; numerals, not words; every unverified claim is an `A-n`
assumption and gets resolved here.

**Phases.** P1 foundation + Hermes + 1 trial. P2 minimal loop + graders + 22 tasks +
judge tooling. P3 experiments + scheduler + stats + exports. P4 UI. P5 the real
experiment + README + video script. P6 failure categories (stretch). After P3 the
submission is coherent without the UI.

**Status.** No phase started. Next action: claim P1 (`cards/P1.md` §0).
