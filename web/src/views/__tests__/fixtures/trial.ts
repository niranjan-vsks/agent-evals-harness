// Fixture payloads for the trial inspector tests. Shapes follow web/src/api/types.ts and the real payloads of
// experiment 01M5QZWXXE77N7V148HE1R9W03 (trial mem-01-staging-db, exact_match, exit reason max_steps).
import type { ExperimentDetail, FullTrace, GraderResult, PartialTrace, Task, TraceEvent, Trial } from '../../../api/types';

export const EXP_ID = '01M5QZWXXE77N7V148HE1R9W03';
export const CONFIG_ID = '01M5Q85G0G7A3SQY0RTCB9XMDA';
export const TRIAL_ID = '01M5QZWXZBM7R7JCTAESKJKQ69';
export const TASK_HASH = 'bdee9c79e3772010e4c8bcee8880f40de4c1496eeca4b98511a444e1bae9d649';

export const USER_PROMPT = 'What are the host and the port of our staging database? Finish your reply with a line of the form FINAL: <host>:<port>.';
export const SYSTEM_PROMPT = 'You are Hermes Agent, built by Nous Research. SYSTEM-PROMPT-MARKER Be direct.';
export const FINAL_RESPONSE = 'I searched the workspace and found nothing.\n\nFINAL: unknown:unknown';

export const JUDGE_REASONING =
  'The answer names the right host but never states the port.\nIt also invents a rollback step that the logs do not support.\nVerdict: not acceptable.';

export function makeTrial(over: Partial<Trial> = {}): Trial {
  return {
    id: TRIAL_ID,
    experiment_id: EXP_ID,
    config_id: CONFIG_ID,
    task_id: 'mem-01-staging-db',
    task_version_hash: TASK_HASH,
    trial_index: 1,
    seed: 1286244256,
    status: 'done',
    attempt_count: 1,
    passed: false,
    exit_reason: 'max_steps',
    steps: 15,
    input_tokens: 73431,
    output_tokens: 1096,
    cache_read_tokens: 12,
    reasoning_tokens: 34,
    api_calls: 15,
    latency_ms: 61000,
    cost_usd: 0.001419,
    harness_cost_usd: 0.002,
    price_snapshot: { input_price_per_mtok: 0.018, output_price_per_mtok: 0.09 },
    rate_limit_events: 2,
    error_class: null,
    error_message: null,
    failure_category: 'step_exhaustion',
    failure_evidence: { rule: 1, category: 'step_exhaustion', detail: 'exit_reason is max_steps (15 steps)' },
    started_at: '2026-10-24T22:18:30.308Z',
    ended_at: '2026-10-24T22:19:31.000Z',
    grader_results: [exactMatchFail()],
    ...over,
  };
}

export function exactMatchFail(over: Record<string, unknown> = {}): GraderResult {
  return {
    grader_index: 0,
    grader_type: 'exact_match',
    passed: false,
    details: { expected: 'pg-stage-07.internal:6432', extracted: 'unknown:unknown', normalized: 'unknown:unknown', used_fallback: false, ...over },
    reasoning: null,
    judge_model_id: null,
    judge_prompt_hash: null,
    duration_ms: 0,
  };
}

/** The shape the worker records when the agent produced no final response at all. */
export function exactMatchNoResponse(): GraderResult {
  return {
    grader_index: 0,
    grader_type: 'exact_match',
    passed: false,
    details: { reason: 'no final response', expected: 'x:1', extracted: null },
    reasoning: null,
    judge_model_id: null,
    judge_prompt_hash: null,
    duration_ms: 0,
  };
}

export function exactMatchPass(): GraderResult {
  return {
    grader_index: 0,
    grader_type: 'exact_match',
    passed: true,
    details: { expected: 'PASSING-EXPECTED-VALUE', extracted: 'PASSING-EXPECTED-VALUE', normalized: 'passing-expected-value', used_fallback: false },
    reasoning: null,
    judge_model_id: null,
    judge_prompt_hash: null,
    duration_ms: 0,
  };
}

export function fileStateFail(): GraderResult {
  return {
    grader_index: 1,
    grader_type: 'file_state',
    passed: false,
    details: {
      checks: [
        { check: { path: 'config.ini', contains: 'port=6432' }, passed: true, reason: 'contains' },
        { check: { path: 'deploy/notes.txt', exists: true }, passed: false, reason: 'file does not exist' },
      ],
    },
    reasoning: null,
    judge_model_id: null,
    judge_prompt_hash: null,
    duration_ms: 3,
  };
}

export function unitTestFail(over: Record<string, unknown> = {}): GraderResult {
  return {
    grader_index: 2,
    grader_type: 'unit_test',
    passed: false,
    details: {
      command: 'pytest -q tests/test_parse.py',
      exit_code: 1,
      timed_out: false,
      output: 'collected 3 items\n\nFAILED tests/test_parse.py::test_ports - AssertionError: 6431 != 6432\n\n',
      ...over,
    },
    reasoning: null,
    judge_model_id: null,
    judge_prompt_hash: null,
    duration_ms: 1840,
  };
}

export function traceCheckFail(): GraderResult {
  return {
    grader_index: 3,
    grader_type: 'trace_check',
    passed: false,
    details: {
      assertions: [
        { assertion: { kind: 'tool_called', tool: 'shell', args_regex: 'lint\\.py\\s+--strict' }, passed: true, reason: '4 call(s) of shell match' },
        { assertion: { kind: 'max_steps', limit: 10 }, passed: false, reason: '15 step(s), limit 10' },
      ],
    },
    reasoning: null,
    judge_model_id: null,
    judge_prompt_hash: null,
    duration_ms: 1,
  };
}

export function llmJudgeFail(): GraderResult {
  return {
    grader_index: 4,
    grader_type: 'llm_judge',
    passed: false,
    details: {
      criteria: [
        { id: 'c1', met: true, evidence: 'host named' },
        { id: 'c2', met: false, evidence: 'port missing from the answer' },
      ],
      pass_rule: 'all',
      judge_model_slug: 'openai/gpt-oss-120b',
      model_pass: true,
      attempts: 1,
      usage: { input_tokens: 900, output_tokens: 60 },
      judged_inputs: [{ name: 'final_response', text: 'JUDGED-INPUT-TEXT the host is pg-stage-07.internal' }],
      raw_response: '{"pass":true}',
    },
    reasoning: JUDGE_REASONING,
    judge_model_id: '01JUDGEMODELID0000000000',
    judge_prompt_hash: 'abc123def4567890',
    duration_ms: 5200,
  };
}

// ---------------------------------------------------------------- events

export function makeEvents(): TraceEvent[] {
  return [
    { seq: 0, t_ms: 10977, kind: 'message', role: 'system', step: 1, content: SYSTEM_PROMPT },
    { seq: 1, t_ms: 10978, kind: 'message', role: 'user', step: 1, content: USER_PROMPT },
    { seq: 2, t_ms: 11000, kind: 'memory_read', file: 'MEMORY.md', content: 'staging db: pg-stage-07.internal:6432', loaded_by: 'harness' },
    { seq: 3, t_ms: 12000, kind: 'skill_invoked', name: 'db-lookup', via: 'preload' },
    { seq: 4, t_ms: 14037, kind: 'api_call', step: 1, model: 'openai/gpt-oss-20b', status: 'ok', latency_ms: 3099, http_status: 200, input_tokens: 4191, output_tokens: 72 },
    {
      seq: 5,
      t_ms: 14357,
      kind: 'tool_call',
      step: 1,
      tool: 'files',
      call_id: 'call-A',
      harness_tool: 'search_files',
      args: { path: '', limit: 20, target: 'files', pattern: 'staging' },
    },
    { seq: 6, t_ms: 14783, kind: 'tool_result', call_id: 'call-A', output: '{"total_count": 0, "marker": "RESULT-OUTPUT-A"}', is_error: false, duration_ms: 447 },
    { seq: 7, t_ms: 15000, kind: 'tool_call', step: 2, tool: 'shell', call_id: 'call-B', harness_tool: 'terminal', args: { command: 'env | grep -i staging' } },
    { seq: 8, t_ms: 15100, kind: 'tool_result', call_id: 'call-B', output: 'exit 1 no matches', is_error: true, duration_ms: 89 },
    {
      seq: 9,
      t_ms: 15500,
      kind: 'memory_write',
      file: 'MEMORY.md',
      op: 'add',
      args: { content: 'note to self' },
      content_after: 'staging db: pg-stage-07.internal:6432\nnote to self',
    },
    { seq: 10, t_ms: 16000, kind: 'api_call', step: 2, model: 'openai/gpt-oss-20b', status: 'retry', latency_ms: 900, http_status: 429, input_tokens: 10, output_tokens: 0 },
    { seq: 11, t_ms: 17000, kind: 'error', stage: 'run', message: 'provider hiccup', retryable: true },
    { seq: 12, t_ms: 18000, kind: 'message', role: 'assistant', step: 3, content: FINAL_RESPONSE },
  ];
}

/** n synthetic events: alternating assistant messages and api calls, seq 0..n-1. */
export function manyEvents(n: number): TraceEvent[] {
  const out: TraceEvent[] = [];
  for (let i = 0; i < n; i++) {
    if (i === 0) out.push({ seq: 0, t_ms: 0, kind: 'message', role: 'user', step: 0, content: USER_PROMPT });
    else if (i % 2 === 1) out.push({ seq: i, t_ms: i * 10, kind: 'message', role: 'assistant', step: i, content: `synthetic message ${i}` });
    else out.push({ seq: i, t_ms: i * 10, kind: 'api_call', step: i, model: 'm', status: 'ok', latency_ms: 5, http_status: 200, input_tokens: 1, output_tokens: 1 });
  }
  return out;
}

export function makeFullTrace(over: Partial<FullTrace> = {}): FullTrace {
  return {
    trial_id: TRIAL_ID,
    schema_version: 1,
    harness_id: 'hermes',
    harness_version: 'f4ac0bea1e',
    model_slug: 'openai/gpt-oss-20b',
    system_prompt: SYSTEM_PROMPT,
    events: makeEvents(),
    memory_initial: { 'MEMORY.md': 'staging db: pg-stage-07.internal:6432', 'USER.md': 'same user' },
    memory_final: { 'MEMORY.md': 'staging db: pg-stage-07.internal:6432\nnote to self', 'USER.md': 'same user' },
    skills_invoked: ['db-lookup'],
    notes: ['adapter note: memory was seeded'],
    final_response: FINAL_RESPONSE,
    grader_results: [],
    ...over,
  };
}

export function makePartialTrace(over: Partial<PartialTrace> = {}): PartialTrace {
  return {
    trial_id: TRIAL_ID,
    partial: true,
    events: [
      { seq: 0, t_ms: 5, kind: 'message', role: 'user', step: 1, content: USER_PROMPT },
      { seq: 1, t_ms: 900, kind: 'error', stage: 'run', message: 'connection reset by peer', retryable: true },
    ],
    error_class: 'provider_error',
    error_message: 'upstream closed the connection',
    grader_results: [],
    ...over,
  };
}

export function makeExperiment(): ExperimentDetail {
  return {
    id: EXP_ID,
    name: 'memory off vs seeded',
    status: 'completed',
    n_trials: 2,
    seed: 7,
    phase: 'pilot',
    axis: 'memory',
    hypothesis: 'seeded memory helps',
    worker_manifest: {},
    created_at: '2026-10-24T22:00:00.000Z',
    started_at: '2026-10-24T22:18:00.000Z',
    finished_at: '2026-10-24T22:30:00.000Z',
    pause_reason: null,
    paused: false,
    progress: { pending: 0, running: 0, done: 12, errored: 0, cancelled: 0, total: 12 },
    configs: [
      { id: CONFIG_ID, name: 'hermes memory seeded', position: 1, harness_id: 'hermes', model_slug: 'openai/gpt-oss-20b' },
      { id: '01M5Q85G4GVMM7X56XAWX7G2QM', name: 'hermes memory off', position: 0, harness_id: 'hermes', model_slug: 'openai/gpt-oss-20b' },
    ],
    tasks: [{ task_id: 'mem-01-staging-db', task_version_hash: TASK_HASH, category: 'memory_dependent' }],
  };
}

export function makeTask(over: Partial<Task> = {}): Task {
  return {
    id: 'mem-01-staging-db',
    version_hash: TASK_HASH,
    category: 'memory_dependent',
    prompt: 'REGISTRY-PROMPT what is the staging database?',
    fixture_dir: null,
    memory_fixture: null,
    graders: [{ type: 'exact_match' }],
    discriminates: null,
    tags: [],
    ...over,
  };
}
