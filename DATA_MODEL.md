# DATA_MODEL.md: tasks, configs, experiments, trials, traces

Storage: PostgreSQL 16, accessed from the NestJS API through Prisma. The worker has no
database connection; it receives a `TrialSpec` and returns a `TrialResult` over HTTP.
Every constraint that carries an invariant has an id (`D-n`) and a reason. The P1 builder
writes the Prisma schema from this file; where Prisma cannot express a constraint
(CHECK constraints, partial uniqueness), it goes in a raw SQL migration and a test.

Conventions: ids are ULIDs (`text`, 26 chars) unless the row is content-addressed.
Times are `timestamptz`. JSON columns are `jsonb`. Money is `numeric(12,6)` USD.
Enums are Postgres enums, not strings, so an undefined state is unrepresentable (D-1).

---

## 1. Entity map

```
model ──────────┐
harness ────────┼──< config >────────┐
memory_fixture ─┘  (immutable,       │
                    content-hashed)  │
task (versioned by hash) ─┐          │
                          ├──< experiment >──< trial >──< trial_attempt
                          │        │             ├── trace (1:1)
                          │        │             └──< grader_result ──< judge_label
                          │        └──< comparison_run
                          └── judge_validation (global, latest wins)
```

---

## 2. Tables

### 2.1 `model`

| column | type | constraint |
|---|---|---|
| id | text PK | matches `^[a-z0-9-]+$` |
| display_name | text | |
| slug | text UNIQUE | provider slug on the wire |
| base_url | text | |
| api_key_env | text | name of the env var, never the value (ADAPTERS M-4) |
| input_price_per_mtok | numeric(12,6) | ≥ 0 |
| output_price_per_mtok | numeric(12,6) | ≥ 0 |
| context_window | int | > 0 |
| roles | text[] | subset of {candidate, judge} |
| created_at | timestamptz | |

Seeded from `api/seed/models.json` at startup (upsert by id). Price edits are allowed:
history is protected by `trial.price_snapshot` (D-7), not by freezing this table.

### 2.2 `harness`

| column | type | constraint |
|---|---|---|
| id | text | PK with version |
| version | text | |
| capabilities | jsonb | ADAPTERS `Capabilities` serialized |
| recorded_at | timestamptz | |

PK `(id, version)`. Written at API startup from the worker's `GET /adapters`. A harness
version that was ever used by a config is never deleted (FK from `config`).

### 2.3 `memory_fixture`

| column | type | constraint |
|---|---|---|
| name | text | |
| hash | text | sha256 of the sorted (filename, bytes) pairs |
| files | jsonb | `{"MEMORY.md": "...", "USER.md": "..."}` |
| synced_at | timestamptz | |

PK `(name, hash)`. Synced from `tasks/memory/<name>/` at startup. Content is stored in the
DB so a config can be reproduced after the file on disk changes (D-5).

### 2.4 `task`

| column | type | constraint |
|---|---|---|
| id | text | matches `^[a-z]+-[0-9]{2}(-[a-z0-9-]+)?$` |
| version_hash | text | sha256 over canonical task JSON + fixture tree (path, bytes) |
| category | enum task_category | `memory_dependent`, `memory_distractor`, `neutral_deterministic`, `neutral_judged`, `honesty` |
| prompt | text | |
| fixture_dir | text NULL | path relative to `tasks/` |
| memory_fixture | text NULL | fixture name this task was written against |
| graders | jsonb | non-empty array of grader specs (DESIGN.md section 7.3) |
| discriminates | text[] | subset of {memory, skills, model, harness}; informational |
| tags | text[] | |
| is_current | bool | true for the version currently on disk |
| synced_at | timestamptz | |

PK `(id, version_hash)`. **D-2: at most 1 row per `id` has `is_current = true`**
(partial unique index on `id WHERE is_current`). Old versions are kept because
experiments reference them (D-6). Changing a task file and re-syncing inserts a new
version; it never updates an old one.

### 2.5 `config`

| column | type | constraint |
|---|---|---|
| id | text PK | ULID |
| name | text | label only, not identity |
| harness_id | text | FK `harness(id, version)` together with harness_version |
| harness_version | text | |
| model_id | text FK model | |
| model_slug | text | copied from model at creation; part of the hash |
| settings | jsonb | ADAPTERS `Settings`, with `memory.fixture_hash` resolved |
| config_hash | text UNIQUE | sha256(canonical JSON of {harness_id, harness_version, model_slug, settings}) |
| created_at | timestamptz | |

**D-3: configs are immutable.** There is no update endpoint (the API returns 405 on
PUT/PATCH) and a Postgres rule `CREATE RULE config_no_update AS ON UPDATE TO config DO
INSTEAD NOTHING` plus a test that an UPDATE changes 0 rows. Reason: "configs are
versioned so a past result can always be reproduced" is only true if the row a trial
points at cannot change. A new name for the same content is a new row with the same
hash, which `config_hash UNIQUE` rejects: the API returns the existing config instead
(idempotent create). **D-4: the API refuses to create a config whose adapter
`validate()` returns errors** (ADAPTERS H-1), so every stored config is runnable
exactly as written. **D-5: `settings.memory.fixture_hash` is resolved at creation from
`memory_fixture` and included in the hash**, so editing a fixture file produces a
different config, never a silent change to an existing one.

Canonical JSON: keys sorted recursively, no whitespace, numbers as shortest round-trip
representation, UTF-8. Implemented once in `api/src/common/canonical-json.ts` with a
fixed test vector.

### 2.6 `experiment`

| column | type | constraint |
|---|---|---|
| id | text PK | |
| name | text | |
| status | enum experiment_status | `draft`, `queued`, `running`, `completed`, `partial`, `cancelled` |
| n_trials | int | ≥ 1; may only increase (D-9) |
| seed | int | base seed; trial seed = hash(seed, config_id, task_id, trial_index) |
| phase | enum experiment_phase | `pilot`, `full` |
| axis | text NULL | human label of the single axis compared, e.g. "hermes memory off vs seeded" |
| hypothesis | text NULL | pre-registered before the first trial runs; immutable once status leaves `draft` (D-10) |
| worker_manifest | jsonb | `GET /adapters` snapshot at creation, plus worker image digest if available |
| created_at, started_at, finished_at | timestamptz | |
| pause_reason | text NULL | set when the scheduler pauses on consecutive non-retryable errors |

Child tables:

`experiment_config (experiment_id, config_id, position)` PK `(experiment_id, config_id)`,
`position` unique within experiment. 2 or more configs.

`experiment_task (experiment_id, task_id, task_version_hash)` PK `(experiment_id, task_id)`,
FK to `task(id, version_hash)`. **D-6: an experiment pins task versions by hash.** Adding
a task to the set later does not change what an existing experiment ran.

Status derivation (computed by the scheduler after every trial transition, never set by
hand): `running` while any trial is `pending` or `running`; when none remain:
`completed` iff every trial is `done`; `partial` iff at least 1 trial is `errored` or
`cancelled`; `cancelled` only via the cancel endpoint. **D-8: `completed` is
unrepresentable while an `errored` trial exists** (trigger-checked on status write, and
tested). This is how "a partially failed experiment is distinguishable from a completed
one in the data".

**D-9: `n_trials` only increases** (trigger rejects a decrease). "Extend to N" appends
trials with `trial_index` in `[old_n, new_n)`; trials are never deleted. This is what
lets the pilot's 3 trials be reused as the first 3 of the full run.

**D-10: `hypothesis` and `axis` are immutable once `status != 'draft'`**. The point of
pre-registration is that the prediction cannot be edited after seeing data.

### 2.7 `trial`

| column | type | constraint |
|---|---|---|
| id | text PK | |
| experiment_id | FK | |
| config_id | FK | |
| task_id, task_version_hash | FK task | |
| trial_index | int | 0-based |
| seed | int | derived (section 2.6) |
| status | enum trial_status | `pending`, `running`, `done`, `errored`, `cancelled` |
| attempt_count | int | ≥ 0 |
| passed | bool NULL | **D-11: `(status = 'done') = (passed IS NOT NULL)`** CHECK |
| exit_reason | enum exit_reason NULL | `completed`, `max_steps`, `timeout`, `invalid_tool_call`, `agent_error`; NOT NULL iff done |
| steps | int NULL | |
| input_tokens, output_tokens | int NULL | |
| cache_read_tokens, reasoning_tokens | int NULL | |
| api_calls | int NULL | |
| latency_ms | int NULL | wall clock of the harness `run()` |
| cost_usd | numeric(12,6) NULL | computed by the API: tokens × `price_snapshot` |
| harness_cost_usd | numeric(12,6) NULL | as reported by the harness, for comparison only |
| price_snapshot | jsonb NOT NULL | `{input_price_per_mtok, output_price_per_mtok}` copied from `model` when the trial is dispatched (**D-7**) |
| rate_limit_events | int | count of `api_call` events with `http_status = 429`; default 0 |
| error_class | enum error_class NULL | `rate_limited`, `provider_error`, `worker_crash`, `grader_error`, `config_invalid`, `backpressure`, `orphaned`, `cancelled` |
| error_message | text NULL | |
| failure_category | enum failure_category NULL | **D-17**: set exactly when `status = 'done' AND passed = false` (P6). The cause of the failure, assigned by pure rules over the trace and the grader results (`api/src/failures/rules.ts`), first match wins |
| failure_evidence | jsonb NULL | set exactly when `failure_category` is: `{rule, category, detail, event_seq?, related_event_seq?, grader_index?, assertion_index?}`, the rule that matched and the trace event or grader it used |
| started_at, ended_at | timestamptz NULL | |
| heartbeat_at | timestamptz NULL | updated by the scheduler while running; orphan detection |

**D-12: `UNIQUE (experiment_id, config_id, task_id, trial_index)`.** The trial is the
unit of pairing in the statistics; a duplicate would double-count a task.
**D-13: `(status = 'errored') → error_class IS NOT NULL`** CHECK. An error without a
class cannot be routed to the retry policy.

Scored vs excluded: only `status = 'done'` rows enter the statistics. `exit_reason` of
`timeout` or `max_steps` is `done` with `passed = false` (the agent exhausted its budget;
that is a property of harness plus model under this config). `errored` rows are excluded
and counted in the comparison's `n_excluded`.

### 2.8 `trial_attempt`

| column | type | constraint |
|---|---|---|
| id | text PK | |
| trial_id | FK | |
| attempt_no | int | UNIQUE with trial_id |
| started_at, ended_at | timestamptz | |
| result | enum attempt_result | `done`, `errored`, `orphaned`, `cancelled` |
| error_class, error_message | | as above |
| partial_trace | jsonb NULL | events recovered from a failed attempt, for debugging only |

Every dispatch writes an attempt row before the HTTP call (so a crash of the API mid-call
leaves evidence). Retry policy (applied by the scheduler, see DESIGN.md 6.3): retryable
classes re-queue the trial with backoff while `attempt_count < MAX_TRIAL_ATTEMPTS` (3);
`config_invalid` and `cancelled` are terminal.

### 2.9 `trace`

| column | type | constraint |
|---|---|---|
| trial_id | PK, FK trial | 1:1 with a `done` trial; may also exist for an `errored` trial with partial events |
| schema_version | int | 1 |
| harness_id, harness_version, model_slug | text | denormalized for export |
| system_prompt | text NULL | |
| events | jsonb | array of ADAPTERS `TraceEvent`, ordered by `seq` |
| memory_initial | jsonb | `{filename: content}` or `{}` |
| memory_final | jsonb | same shape, after `collect_memory()` |
| skills_invoked | text[] | |
| notes | text[] | adapter notes |
| final_response | text NULL | verbatim |

The trace is write-once (same rule as D-3). Size: events are truncated per field at
20,000 characters by the runner; a trace above 5 MB is rejected by the API with
`error_class: worker_crash` and the trial retried once, then errored (documented limit).

### 2.10 `grader_result`

| column | type | constraint |
|---|---|---|
| id | text PK | |
| trial_id | FK | |
| grader_index | int | position in `task.graders` |
| grader_type | enum grader_type | `exact_match`, `file_state`, `unit_test`, `trace_check`, `llm_judge` |
| passed | bool | |
| details | jsonb | type-specific: extracted answer, file diffs, test output, assertion results |
| reasoning | text NULL | judge reasoning verbatim; NULL for deterministic graders |
| judge_model_id | text NULL | NOT NULL iff `grader_type = 'llm_judge'` |
| judge_prompt_hash | text NULL | same rule |
| duration_ms | int | |

UNIQUE `(trial_id, grader_index)`. **D-14: `trial.passed = AND over grader_result.passed
for that trial`** (computed by the API on ingest; a test asserts the equality on every
ingested trial). A task passes only if every grader passes.

### 2.11 `judge_label`

| column | type | constraint |
|---|---|---|
| id | text PK | |
| trial_id, grader_index | FK grader_result | |
| human_passed | bool | |
| labeler | text | |
| labeled_at | timestamptz | |
| note | text NULL | |

UNIQUE `(trial_id, grader_index, labeler)`. Imported from
`experiments/judge-validation/labels.jsonl`. **D-15: the labelling export never contains
the judge's verdict or reasoning** (the export command strips them; a test asserts the
exported file has no `passed`/`reasoning` keys), so labels are blind.

### 2.12 `judge_validation`

| column | type | constraint |
|---|---|---|
| id | text PK | |
| computed_at | timestamptz | |
| judge_model_id, judge_prompt_hash | text | |
| label_set_hash | text | sha256 of the labels used |
| n_items | int | |
| agreement_raw | numeric(6,4) | fraction of items where judge == human |
| kappa | numeric(6,4) | Cohen's kappa |
| kappa_ci_low, kappa_ci_high | numeric(6,4) | bootstrap over items, 95 percent |
| policy | enum judge_policy | `trusted` (κ ≥ 0.6), `flagged` (0.4 ≤ κ < 0.6), `excluded` (κ < 0.4 or no validation yet) |

The comparison endpoint reads the latest row for the (judge_model, judge_prompt_hash) in
use and applies `policy` (DESIGN.md 8.4). **D-16: with no `judge_validation` row, the
policy is `excluded`.** An unvalidated judge contributes nothing to a headline number;
the UI shows judge tasks separately with a badge.

### 2.13 `comparison_run`

| column | type | constraint |
|---|---|---|
| id | text PK | |
| experiment_id | FK | |
| config_a_id, config_b_id | FK config | |
| computed_at | timestamptz | |
| stats_version | text | version string of `api/src/stats` |
| seed, resamples | int | |
| judge_policy_applied | enum judge_policy | |
| result | jsonb | the full comparison payload (DESIGN.md 9.6) |

Stored on every export so a JSON/CSV export is reproducible from the row, not from
re-running the bootstrap.

---

## 3. Enum catalogue (Postgres types)

```
task_category     memory_dependent | memory_distractor | neutral_deterministic | neutral_judged | honesty
experiment_status draft | queued | running | completed | partial | cancelled
experiment_phase  pilot | full
trial_status      pending | running | done | errored | cancelled
exit_reason       completed | max_steps | timeout | invalid_tool_call | agent_error
error_class       rate_limited | provider_error | worker_crash | grader_error | config_invalid | backpressure | orphaned | cancelled
attempt_result    done | errored | orphaned | cancelled
grader_type       exact_match | file_state | unit_test | trace_check | llm_judge
judge_policy      trusted | flagged | excluded
failure_category  step_exhaustion | timeout | hallucinated_tool_args | wrong_tool | tool_error_unrecovered |
                  no_final_answer | gave_up_early | grader_disagreement | memory_ignored | wrong_answer   (rule order)
```

There is deliberately no `score` float on `trial`, no `simulated` or `manual` origin, and
no `skipped` trial status. A trial is scored, errored, cancelled or not yet run.

---

## 4. Invariant index

| id | 1 line | where |
|---|---|---|
| D-1 | states are Postgres enums | section 3 |
| D-2 | 1 current version per task id | task |
| D-3 | configs immutable (rule + 405) | config |
| D-4 | unrunnable configs cannot be created | config |
| D-5 | memory fixture hash inside config hash | config |
| D-6 | experiments pin task versions by hash | experiment_task |
| D-7 | prices snapshotted per trial | trial |
| D-8 | `completed` impossible with errored trials | experiment |
| D-9 | `n_trials` only increases | experiment |
| D-10 | hypothesis immutable after draft | experiment |
| D-11 | `passed` set iff `done` | trial |
| D-12 | 1 trial per (experiment, config, task, index) | trial |
| D-13 | errored implies error_class | trial |
| D-14 | trial.passed is AND of graders | grader_result |
| D-15 | labelling export is blind | judge_label |
| D-16 | unvalidated judge is excluded | judge_validation |
| D-17 | `failure_category` (and its evidence) set iff done and failed | trial |

---

## 5. Export formats

`GET /experiments/:id/export.json`: `{experiment, configs[], tasks[], trials[] (with
grader_results), comparison_runs[]}`; traces excluded by default, included with
`?traces=1`.

`GET /experiments/:id/export.csv`: 1 row per trial:
`trial_id, config_id, config_name, task_id, task_category, trial_index, status, passed,
exit_reason, steps, input_tokens, output_tokens, cost_usd, latency_ms, rate_limit_events,
error_class, failure_category`.

`GET /experiments/:id/compare.csv?a=&b=`: 1 row per task: `task_id, category, n_a, n_b,
rate_a, rate_b, delta, ci_low, ci_high, verdict`, plus a final `__aggregate__` row.
