/**
 * Pure: TrialResult (worker JSON) -> the rows the API stores. No I/O.
 *
 * Computes cost_usd from the usage and the price snapshot (D-7) and asserts the invariants
 * that cannot be left to a CHECK constraint alone, so a bad worker result fails loudly here
 * instead of as an opaque constraint violation: D-14 (trial.passed is the AND of the graders),
 * D-11 and D-13 shapes, and the trace size limit.
 */
import { Prisma } from '../generated/prisma/client';
import { ErrorClass, ExitReason, GraderResultJson, TraceEventJson, TrialResult } from '../worker-client/types';

export const MAX_TRACE_BYTES = 5 * 1024 * 1024;

const EXIT_REASONS: ExitReason[] = ['completed', 'max_steps', 'timeout', 'invalid_tool_call', 'agent_error'];
const ERROR_CLASSES: ErrorClass[] = [
  'rate_limited',
  'provider_error',
  'worker_crash',
  'grader_error',
  'config_invalid',
  'backpressure',
  'orphaned',
  'cancelled',
];

/** The worker returned something the API cannot store. Treated as plumbing (worker_crash), never as a scored failure. */
export class IngestError extends Error {}

export interface PriceSnapshot {
  input_price_per_mtok: number;
  output_price_per_mtok: number;
}

export interface IngestedTrial {
  status: 'done' | 'errored';
  passed: boolean | null;
  exitReason: ExitReason | null;
  steps: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  reasoningTokens: number | null;
  apiCalls: number | null;
  latencyMs: number | null;
  costUsd: Prisma.Decimal | null;
  harnessCostUsd: Prisma.Decimal | null;
  rateLimitEvents: number;
  errorClass: ErrorClass | null;
  errorMessage: string | null;
  trace: {
    harnessId: string;
    harnessVersion: string;
    systemPrompt: string | null;
    events: TraceEventJson[];
    memoryInitial: Record<string, string>;
    memoryFinal: Record<string, string>;
    skillsInvoked: string[];
    notes: string[];
    finalResponse: string | null;
  } | null;
  graders: GraderResultJson[];
  partialTrace: TraceEventJson[] | null;
}

/** tokens x USD per million tokens, to the 6 decimal places the column holds. */
export function costUsd(inputTokens: number, outputTokens: number, price: PriceSnapshot): Prisma.Decimal {
  const D = Prisma.Decimal;
  return new D(inputTokens)
    .mul(new D(String(price.input_price_per_mtok)))
    .plus(new D(outputTokens).mul(new D(String(price.output_price_per_mtok))))
    .div(1_000_000)
    .toDecimalPlaces(6, Prisma.Decimal.ROUND_HALF_UP);
}

export function countRateLimitEvents(events: TraceEventJson[]): number {
  return events.filter((e) => e.kind === 'api_call' && e.http_status === 429).length;
}

export function erroredResult(errorClass: ErrorClass, message: string, partial: TraceEventJson[] | null = null): TrialResult {
  return {
    trial_id: '',
    attempt: 0,
    status: 'errored',
    harness: null,
    outcome: null,
    passed: null,
    trace: null,
    grader_results: [],
    error_class: errorClass,
    error_message: message,
    partial_trace: partial,
  };
}

export function ingest(result: TrialResult, price: PriceSnapshot): IngestedTrial {
  if (result.status === 'errored') {
    if (!result.error_class || !ERROR_CLASSES.includes(result.error_class)) {
      throw new IngestError(`errored result without a valid error_class (D-13): ${String(result.error_class)}`);
    }
    return {
      status: 'errored',
      passed: null,
      exitReason: null,
      steps: null,
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      reasoningTokens: null,
      apiCalls: null,
      latencyMs: null,
      costUsd: null,
      harnessCostUsd: null,
      rateLimitEvents: countRateLimitEvents(result.partial_trace ?? []),
      errorClass: result.error_class,
      errorMessage: result.error_message,
      trace: null,
      graders: [],
      partialTrace: result.partial_trace,
    };
  }

  const { outcome, trace } = result;
  if (result.status !== 'done' || !outcome || !trace) throw new IngestError('a done result needs outcome and trace');
  if (!EXIT_REASONS.includes(outcome.exit_reason)) throw new IngestError(`unknown exit_reason ${outcome.exit_reason}`);
  if (typeof result.passed !== 'boolean') throw new IngestError('a done result needs passed (D-11)');
  if (result.grader_results.length === 0) throw new IngestError('a done result needs at least 1 grader result');

  for (const g of result.grader_results) {
    const judge = g.grader_type === 'llm_judge';
    if (judge !== (g.judge_model_id !== null) || judge !== (g.judge_prompt_hash !== null)) {
      throw new IngestError(`grader ${g.grader_index}: judge_model_id and judge_prompt_hash are set exactly for llm_judge`);
    }
  }
  const allPassed = result.grader_results.every((g) => g.passed);
  if (result.passed !== allPassed) {
    throw new IngestError(`D-14: trial.passed is ${result.passed} but the graders' AND is ${allPassed}`);
  }
  if (outcome.exit_reason === 'timeout' && result.passed) throw new IngestError('a timed-out trial cannot pass (R-2)');

  if (Buffer.byteLength(JSON.stringify(trace.events), 'utf8') > MAX_TRACE_BYTES) {
    throw new IngestError(`trace is larger than ${MAX_TRACE_BYTES} bytes`);
  }

  const u = outcome.usage;
  const harnessCost = outcome.harness_reported_cost_usd;
  return {
    status: 'done',
    passed: result.passed,
    exitReason: outcome.exit_reason,
    steps: outcome.steps,
    inputTokens: u.input_tokens,
    outputTokens: u.output_tokens,
    cacheReadTokens: u.cache_read_tokens,
    reasoningTokens: u.reasoning_tokens,
    apiCalls: u.api_calls,
    latencyMs: outcome.latency_ms,
    costUsd: costUsd(u.input_tokens, u.output_tokens, price),
    harnessCostUsd: typeof harnessCost === 'number' ? new Prisma.Decimal(harnessCost).toDecimalPlaces(6) : null,
    rateLimitEvents: countRateLimitEvents(trace.events),
    errorClass: null,
    errorMessage: null,
    trace: {
      harnessId: result.harness?.id ?? '',
      harnessVersion: result.harness?.version ?? '',
      systemPrompt: trace.system_prompt,
      events: trace.events,
      memoryInitial: trace.memory_initial,
      memoryFinal: trace.memory_final,
      skillsInvoked: trace.skills_invoked,
      notes: trace.notes,
      finalResponse: trace.final_response,
    },
    graders: result.grader_results,
    partialTrace: null,
  };
}
