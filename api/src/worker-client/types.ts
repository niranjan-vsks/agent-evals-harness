/**
 * TypeScript mirror of the worker's HTTP contract (ADAPTERS 0): ModelSpec and the manifest,
 * plus the 2 JSON shapes TrialSpec (in) and TrialResult (out). Shapes are documented in
 * worker/spec.py and worker/runner.py. The API never imports harness code.
 */
export type PlatformTool = 'shell' | 'files';
export type MemoryMode = 'off' | 'seeded';

export interface ModelSpecJson {
  id: string;
  slug: string;
  base_url: string;
  api_key_env: string;
  input_price_per_mtok: number;
  output_price_per_mtok: number;
  context_window: number;
}

export interface SettingsJson {
  tools: PlatformTool[];
  memory: { mode: MemoryMode; fixture: string | null; fixture_hash: string | null };
  skills: { enabled: boolean; preload: string[] };
  temperature: number;
  max_steps: number;
  max_output_tokens: number;
  timeout_seconds: number;
  harness_options: Record<string, unknown>;
}

export interface CapabilitiesJson {
  tools: PlatformTool[];
  memory_modes: MemoryMode[];
  memory_writes: boolean;
  skills: boolean;
  temperature: boolean;
  seed: boolean;
  system_prompt_capture: boolean;
}

export interface WorkerManifest {
  adapters: { id: string; version: string; capabilities: CapabilitiesJson }[];
  worker: { python: string; platform: string; image_digest: string | null };
}

export interface TrialSpec {
  trial_id: string;
  attempt: number;
  seed: number;
  harness: string;
  model: ModelSpecJson;
  settings: SettingsJson;
  task: {
    id: string;
    version_hash: string;
    prompt: string;
    fixture_dir: string | null;
    memory_fixture: string | null;
    graders: unknown[];
  };
  memory_seed: Record<string, string> | null;
  /** Present exactly when a grader is llm_judge: the registry row of JUDGE_MODEL_ID. */
  judge_model?: ModelSpecJson | null;
}

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

export interface TraceEventJson {
  seq: number;
  t_ms: number;
  kind: string;
  [field: string]: unknown;
}

export interface GraderResultJson {
  grader_index: number;
  grader_type: 'exact_match' | 'file_state' | 'unit_test' | 'trace_check' | 'llm_judge';
  passed: boolean;
  details: Record<string, unknown>;
  reasoning: string | null;
  judge_model_id: string | null;
  judge_prompt_hash: string | null;
  duration_ms: number;
}

export interface TrialOutcomeJson {
  exit_reason: ExitReason;
  final_response: string | null;
  steps: number;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number | null;
    reasoning_tokens: number | null;
    api_calls: number;
  };
  harness_reported_cost_usd: number | null;
  latency_ms: number;
}

export interface TrialResult {
  trial_id: string;
  attempt: number;
  status: 'done' | 'errored';
  harness: { id: string; version: string } | null;
  outcome: TrialOutcomeJson | null;
  passed: boolean | null;
  trace: {
    events: TraceEventJson[];
    system_prompt: string | null;
    memory_initial: Record<string, string>;
    memory_final: Record<string, string>;
    skills_invoked: string[];
    notes: string[];
    final_response: string | null;
  } | null;
  grader_results: GraderResultJson[];
  error_class: ErrorClass | null;
  error_message: string | null;
  partial_trace: TraceEventJson[] | null;
}
