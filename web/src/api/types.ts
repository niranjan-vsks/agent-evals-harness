// Hand-written mirrors of the API's JSON (cards/P4.md section 10.1). Field names are the wire names (snake_case).
// Sources: api/src/{configs,experiments,trials,compare,export,tasks,models,harnesses}/*.ts, api/src/stats/{compare,pilot}.ts,
// DESIGN.md 9.6 (comparison payload), ADAPTERS.md section 1 (trace events), DATA_MODEL.md 2.9 and 2.10.

export type PlatformTool = 'shell' | 'files';
export type MemoryMode = 'off' | 'seeded';

export type ExperimentStatus = 'draft' | 'queued' | 'running' | 'completed' | 'partial' | 'cancelled';
export type TrialStatus = 'pending' | 'running' | 'done' | 'errored' | 'cancelled';
export type ExitReason = 'completed' | 'max_steps' | 'timeout' | 'invalid_tool_call' | 'agent_error';
export type ErrorClass =
  | 'rate_limited'
  | 'provider_error'
  | 'worker_crash'
  | 'grader_error'
  | 'config_invalid'
  | 'backpressure'
  | 'orphaned'
  | 'cancelled';
export type Phase = 'pilot' | 'full';
export type TaskCategory = 'memory_dependent' | 'memory_distractor' | 'neutral_deterministic' | 'neutral_judged' | 'honesty';
export type GraderType = 'exact_match' | 'file_state' | 'unit_test' | 'trace_check' | 'llm_judge';
export type JudgePolicy = 'trusted' | 'flagged' | 'excluded';
export type Verdict = 'A_better' | 'B_better' | 'noise';

// ---------------------------------------------------------------- registries

export interface Model {
  id: string;
  display_name: string;
  slug: string;
  base_url: string;
  api_key_env: string;
  input_price_per_mtok: number;
  output_price_per_mtok: number;
  context_window: number;
  roles: Array<'candidate' | 'judge'>;
  created_at: string;
}

export interface Capabilities {
  tools: PlatformTool[];
  memory_modes: MemoryMode[];
  memory_writes: boolean;
  skills: boolean;
  temperature: boolean;
  seed: boolean;
  system_prompt_capture: boolean;
}

/** GET /harnesses: 1 row per (id, version), newest version first within an id. */
export interface Harness {
  id: string;
  version: string;
  capabilities: Capabilities;
  recorded_at: string;
}

/** GET /tasks: the current version of each task. */
export interface Task {
  id: string;
  version_hash: string;
  category: TaskCategory;
  prompt: string;
  fixture_dir: string | null;
  memory_fixture: string | null;
  graders: Array<{ type: GraderType } & Record<string, unknown>>;
  discriminates: unknown;
  tags: string[];
}

// ---------------------------------------------------------------- configs

/** The settings as stored (normalized by the API): `memory` always has the 3 fields. */
export interface ConfigSettings {
  tools: PlatformTool[];
  memory: { mode: MemoryMode; fixture: string | null; fixture_hash: string | null };
  skills: { enabled: boolean; preload: string[] };
  temperature: number;
  max_steps: number;
  max_output_tokens: number;
  timeout_seconds: number;
  harness_options: Record<string, unknown>;
}

export interface Config {
  id: string;
  name: string;
  harness_id: string;
  harness_version: string;
  model_id: string;
  model_slug: string;
  settings: ConfigSettings;
  config_hash: string;
  created_at: string;
}

/** POST /configs body. `fixture` and `harness_options` are optional on the wire. */
export interface CreateConfigBody {
  name: string;
  harness_id: string;
  model_id: string;
  settings: {
    tools: PlatformTool[];
    memory: { mode: MemoryMode; fixture?: string | null };
    skills: { enabled: boolean; preload: string[] };
    temperature: number;
    max_steps: number;
    max_output_tokens: number;
    timeout_seconds: number;
    harness_options?: Record<string, unknown>;
  };
}

/** POST /configs answers 201 for a new config and 200 for an existing one with the same content hash. */
export interface CreateConfigResult {
  created: boolean;
  config: Config;
}

// ---------------------------------------------------------------- experiments

export interface Progress {
  pending: number;
  running: number;
  done: number;
  errored: number;
  cancelled: number;
  total: number;
}

export interface Experiment {
  id: string;
  name: string;
  status: ExperimentStatus;
  n_trials: number;
  seed: number;
  phase: Phase;
  axis: string | null;
  hypothesis: string | null;
  worker_manifest: unknown;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  pause_reason: string | null;
  /** True when the circuit breaker paused a queued or running experiment; POST /resume clears it. */
  paused: boolean;
  progress: Progress;
}

/** GET /experiments/:id adds the config and task lists. */
export interface ExperimentDetail extends Experiment {
  configs: Array<{ id: string; name: string; position: number; harness_id: string; model_slug: string }>;
  tasks: Array<{ task_id: string; task_version_hash: string; category: TaskCategory }>;
}

export interface CreateExperimentBody {
  name: string;
  config_ids: string[];
  task_ids?: string[];
  n_trials: number;
  seed?: number;
  axis?: string;
  hypothesis?: string;
  phase?: Phase;
}

export type FailureCategory =
  | 'step_exhaustion'
  | 'timeout'
  | 'hallucinated_tool_args'
  | 'wrong_tool_usage'
  | 'tool_error_unrecovered'
  | 'no_final_answer'
  | 'gave_up_early'
  | 'judge_criteria_unmet'
  | 'grader_disagreement'
  | 'memory_ignored'
  | 'abstained'
  | 'wrong_answer';

/** trial.failure_evidence (api/src/failures/rules.ts): the rule that matched and the trace event or grader it used. */
export interface FailureEvidence {
  rule: number;
  category: FailureCategory;
  detail: string;
  event_seq?: number;
  related_event_seq?: number;
  grader_index?: number;
  assertion_index?: number;
}

/** A row of GET /experiments/:id/trials. */
export interface TrialRow {
  id: string;
  experiment_id: string;
  config_id: string;
  task_id: string;
  task_version_hash: string;
  trial_index: number;
  seed: number;
  status: TrialStatus;
  attempt_count: number;
  passed: boolean | null;
  exit_reason: ExitReason | null;
  steps: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  reasoning_tokens: number | null;
  api_calls: number | null;
  latency_ms: number | null;
  cost_usd: number | null;
  harness_cost_usd: number | null;
  price_snapshot: { input_price_per_mtok: number; output_price_per_mtok: number } | null;
  rate_limit_events: number;
  error_class: ErrorClass | null;
  error_message: string | null;
  /** Set exactly when the trial is done and failed. */
  failure_category: FailureCategory | null;
  failure_evidence: FailureEvidence | null;
  started_at: string | null;
  ended_at: string | null;
}

export interface TrialsFilter {
  status?: TrialStatus;
  config_id?: string;
  task_id?: string;
}

// ---------------------------------------------------------------- trial and trace

export interface GraderResult {
  grader_index: number;
  grader_type: GraderType;
  passed: boolean;
  /** Type specific. exact_match: {expected, extracted, normalized, used_fallback}. file_state: {checks: [{check, passed, reason}]}.
   *  unit_test: {command, exit_code, timed_out, output}. trace_check: {assertions: [...]}. llm_judge: {criteria, pass_rule, judged_inputs, ...}. */
  details: Record<string, unknown> | null;
  /** The judge's reasoning, verbatim; null for deterministic graders. */
  reasoning: string | null;
  judge_model_id: string | null;
  judge_prompt_hash: string | null;
  duration_ms: number;
}

/** GET /trials/:id: the trial row (same fields as a TrialRow) with its grader results. */
export interface Trial extends TrialRow {
  grader_results: GraderResult[];
}

interface EventBase {
  seq: number;
  t_ms: number;
}

export type TraceEvent =
  | (EventBase & { kind: 'message'; role: 'system' | 'user' | 'assistant'; content: string; step: number; truncated?: boolean; orig_len?: number })
  | (EventBase & { kind: 'tool_call'; call_id: string; step: number; tool: string; harness_tool: string; args: Record<string, unknown> })
  | (EventBase & { kind: 'tool_result'; call_id: string; output: string; is_error: boolean; duration_ms: number; truncated?: boolean; orig_len?: number })
  | (EventBase & {
      kind: 'api_call';
      step: number;
      model: string;
      input_tokens: number;
      output_tokens: number;
      latency_ms: number;
      status: 'ok' | 'retry' | 'error';
      http_status: number | null;
    })
  | (EventBase & { kind: 'memory_read'; file: string; content: string; loaded_by: 'harness' | 'adapter'; truncated?: boolean; orig_len?: number })
  | (EventBase & { kind: 'memory_write'; file: string; op: string; args: Record<string, unknown>; content_after: string | null })
  | (EventBase & { kind: 'skill_invoked'; name: string; via: 'preload' | 'tool' })
  | (EventBase & { kind: 'error'; stage: 'prepare' | 'run' | 'collect'; message: string; retryable: boolean; http_status?: number | null });

/** GET /trials/:id/trace for a trial with a stored trace. */
export interface FullTrace {
  trial_id: string;
  schema_version: number;
  harness_id: string;
  harness_version: string;
  model_slug: string;
  system_prompt: string | null;
  events: TraceEvent[];
  memory_initial: Record<string, string>;
  memory_final: Record<string, string>;
  skills_invoked: string[];
  notes: string[];
  final_response: string | null;
  grader_results: GraderResult[];
  partial?: undefined;
}

/** GET /trials/:id/trace for an errored trial that has no stored trace: only the partial events of the last attempt. */
export interface PartialTrace {
  trial_id: string;
  partial: true;
  events: TraceEvent[];
  error_class: ErrorClass | null;
  error_message: string | null;
  grader_results: GraderResult[];
}

export type Trace = FullTrace | PartialTrace;

// ---------------------------------------------------------------- comparison (DESIGN.md 9.6, api/src/stats/compare.ts)

export interface AggregateBlock {
  p_a: number | null;
  p_b: number | null;
  delta: number | null;
  ci_low: number | null;
  ci_high: number | null;
  verdict: Verdict | 'insufficient_data';
  min_detectable: number | null;
  /** Present when the verdict is insufficient_data because only 1 task was paired. */
  reason?: string;
  resamples: number;
  seed: number;
}

export interface CategoryBlock extends AggregateBlock {
  n_tasks: number;
}

export interface PerTaskRow {
  task_id: string;
  category: TaskCategory;
  n_a: number;
  n_b: number;
  rate_a: number | null;
  rate_b: number | null;
  delta: number | null;
  ci_low: number | null;
  ci_high: number | null;
  verdict: Verdict | 'insufficient_data';
  direction_only: true;
  /** The task is judged and the judge policy is `excluded`: shown, but kept out of every headline figure. */
  judge_excluded: boolean;
  /** The commonest failure category among A's (B's) failed trials of this task, null when it has none. */
  failure_category_a: FailureCategory | null;
  failure_category_b: FailureCategory | null;
}

export type FailureCounts = Record<FailureCategory, number>;

export interface FailureHistogram {
  a: FailureCounts;
  b: FailureCounts;
  /** Failed trials with no category yet (a database that was not backfilled); counted in neither a nor b. */
  uncategorized: { a: number; b: number };
}

export interface MetricBlock {
  mean: number | null;
  ci_low: number | null;
  ci_high: number | null;
}

export interface MetricComparison {
  a: MetricBlock;
  b: MetricBlock;
  /** 95 percent interval of the paired difference A - B. */
  delta_ci: [number, number] | null;
}

export interface SignTest {
  a_wins: number;
  b_wins: number;
  ties: number;
  p_value: number;
}

export interface McNemar {
  /** A passed, B failed. */
  a_only: number;
  /** B passed, A failed. */
  b_only: number;
  both_pass: number;
  both_fail: number;
  n_pairs: number;
  n_discordant: number;
  p_value: number;
}

export interface ComparePayload {
  experiment_id: string;
  config_a: { id: string; name: string };
  config_b: { id: string; name: string };
  axis: string | null;
  n_tasks: number;
  n_trials_per_task: number;
  n_scored: number;
  n_excluded: number;
  n_unfinished: number;
  reliability: 'complete' | 'partial';
  rate_limit_affected_trials: number;
  judge_policy_applied: JudgePolicy;
  judge_confidence: 'low' | null;
  judge: { model_id: string | null; prompt_hash: string | null; kappa: number | null; policy: JudgePolicy };
  judge_excluded_tasks: string[];
  unpaired_tasks: Array<{ task_id: string; reason: string }>;
  ci_method: 'percentile';
  aggregate: AggregateBlock;
  by_category: {
    memory_dependent: CategoryBlock | null;
    memory_distractor: CategoryBlock | null;
    neutral: CategoryBlock | null;
    honesty: CategoryBlock | null;
  };
  sign_test: SignTest;
  mcnemar: McNemar | null;
  mcnemar_omitted: string | null;
  per_task: PerTaskRow[];
  /** Failed trials of the tasks in the headline comparison, per category. */
  failures: FailureHistogram;
  cost: MetricComparison;
  latency_ms: MetricComparison;
  tokens: { input: MetricComparison; output: MetricComparison };
  stats_version: string;
  comparison_run_id?: string;
}

// ---------------------------------------------------------------- pilot (api/src/stats/pilot.ts): variance and projected widths, never a delta

export interface PilotProjection {
  n: number;
  half_width_observed: number | null;
  half_width_observed_without_judged: number | null;
  half_width_bound: number | null;
  trials_total: number;
}

export interface PilotPayload {
  experiment_id: string;
  ready: boolean;
  reason?: string;
  recommendation_reason?: string;
  n_pilot: number;
  n_tasks: number;
  n_judged_tasks: number;
  n_configs: number;
  n_cells_used: number;
  within_task_variance: number | null;
  bernoulli_bound_variance: number;
  target_half_width: number;
  n_cap: number;
  projections: PilotProjection[];
  recommended_n: number | null;
  capped: boolean;
  stats_version: string;
}

// ---------------------------------------------------------------- summary (api/src/summary/summary.service.ts): the home dashboard

export interface SummaryComparison {
  comparison_run_id: string;
  experiment_id: string;
  experiment_name: string;
  axis: string | null;
  config_a_id: string;
  config_a_name: string;
  config_b_id: string;
  config_b_name: string;
  verdict: Verdict | 'insufficient_data';
  delta: number | null;
  ci_low: number | null;
  ci_high: number | null;
  reliability: 'complete' | 'partial';
  judge_policy_applied: JudgePolicy;
  stats_version: string;
  computed_at: string;
}

export interface SummaryConfig {
  config_id: string;
  name: string;
  harness_id: string;
  model_id: string;
  memory_mode: string | null;
  trials_done: number;
  /** Macro: the mean over tasks of each task's pass rate (DESIGN 9.1), over done trials. */
  pass_rate: number | null;
  mean_cost_usd: number | null;
  mean_latency_ms: number | null;
  mean_input_tokens: number | null;
  mean_output_tokens: number | null;
}

export interface SummaryExperiment {
  id: string;
  name: string;
  status: ExperimentStatus;
  n_trials: number;
  progress: Progress;
  created_at: string;
}

export interface SummaryPayload {
  totals: {
    experiments: number;
    configs: number;
    tasks_current: number;
    trials_done: number;
    trials_errored: number;
    spend_usd: number;
    models: number;
    harnesses: number;
  };
  /** Newest 5, the newest persisted comparison_run of each (experiment, A, B) pair. */
  latest_comparisons: SummaryComparison[];
  configs: SummaryConfig[];
  /** Done and failed trials per category, every category in rule order; `uncategorized` only when some have none. */
  failures: Partial<Record<FailureCategory | 'uncategorized', number>>;
  /** Newest 8. */
  recent_experiments: SummaryExperiment[];
}
