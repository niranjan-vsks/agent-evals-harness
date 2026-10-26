/**
 * Pure: TrialResult (worker JSON) -> the rows the API stores. No I/O.
 *
 * Computes cost_usd from the usage and the price snapshot (D-7) and asserts the invariants
 * that cannot be left to a CHECK constraint alone, so a bad worker result fails loudly here
 * instead of as an opaque constraint violation: D-14 (trial.passed is the AND of the graders),
 * D-11 and D-13 shapes, and the trace size limit.
 */
import { Prisma } from '../generated/prisma/client';
import { Categorized, categorize } from '../failures/rules';
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
  /** Absent on a snapshot taken before 0004_cached_input_price (an in-flight trial dispatched before that deploy). */
  cached_input_price_per_mtok?: number;
}

/**
 * The price of a cache-read token. A snapshot without the field falls back to the input price, the safe upper bound:
 * a cached token never costs more than an uncached one, so the cost of such a trial is over-stated, never under-stated.
 */
export function cachedPrice(price: PriceSnapshot): number {
  return price.cached_input_price_per_mtok ?? price.input_price_per_mtok;
}

/**
 * What a done result is checked and categorized against: the task's grader count (the worker must return 1 row per grader) and what
 * the failure rules need to know about the task and the config (P6 card section 4); the trace and graders come from the result.
 */
export interface FailureTask {
  graderCount: number;
  taskCategory: string;
  taskFixtureDir: string | null;
  memoryMode: 'off' | 'seeded';
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
  /** Set exactly when the trial is done and failed (the CHECK of 0003_failure_category). Judge labels cannot exist yet, so rule 8 waits for the backfill. */
  failure: Categorized | null;
}

/**
 * tokens x USD per million tokens, to the 6 decimal places the column holds. input_tokens already EXCLUDES the cache-read
 * tokens (DESIGN.md 13.14), so those are charged on top, at the cached price.
 */
export function costUsd(inputTokens: number, outputTokens: number, price: PriceSnapshot, cacheReadTokens: number | null = null): Prisma.Decimal {
  const D = Prisma.Decimal;
  return new D(inputTokens)
    .mul(new D(String(price.input_price_per_mtok)))
    .plus(new D(outputTokens).mul(new D(String(price.output_price_per_mtok))))
    .plus(new D(cacheReadTokens ?? 0).mul(new D(String(cachedPrice(price)))))
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

/**
 * `task` is needed for every done result: its grader count is checked against the result, and the failure rules read the task
 * category, its fixture and the config's memory mode. A caller that omits it for such a result is a programming error and is
 * refused loudly rather than guessed at. An errored result needs none (a spec that could not be built has no task).
 */
export function ingest(result: TrialResult, price: PriceSnapshot, task?: FailureTask): IngestedTrial {
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
      failure: null,
    };
  }

  const { outcome, trace } = result;
  if (result.status !== 'done' || !outcome || !trace) throw new IngestError('a done result needs outcome and trace');
  if (!EXIT_REASONS.includes(outcome.exit_reason)) throw new IngestError(`unknown exit_reason ${outcome.exit_reason}`);
  if (typeof result.passed !== 'boolean') throw new IngestError('a done result needs passed (D-11)');
  if (result.grader_results.length === 0) throw new IngestError('a done result needs at least 1 grader result');
  if (!task) throw new IngestError('a done result needs the task context (its grader count, and the failure rules) (P6)');
  // D-14 is the AND over the rows given: a row missing for a failing grader would store a failed trial as passed.
  if (result.grader_results.length !== task.graderCount) {
    throw new IngestError(`the task has ${task.graderCount} graders but the result carries ${result.grader_results.length} grader results`);
  }

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

  let failure: Categorized | null = null;
  if (!result.passed) failure = categorizeFailure(result, task);

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
    costUsd: costUsd(u.input_tokens, u.output_tokens, price, u.cache_read_tokens),
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
    failure,
  };
}

/**
 * The rules are total over JSON-shaped input, so this should never throw; if one ever does, a paid and graded trial must not be
 * lost to it. It is stored as wrong_answer with the error in the evidence, which the backfill replaces once the rule is fixed.
 */
function categorizeFailure(result: TrialResult, task: FailureTask): Categorized {
  const { outcome, trace } = result;
  try {
    return categorize(
      { exitReason: outcome!.exit_reason, steps: outcome!.steps, taskCategory: task.taskCategory, taskFixtureDir: task.taskFixtureDir, memoryMode: task.memoryMode },
      { events: trace!.events, finalResponse: trace!.final_response, memoryInitial: trace!.memory_initial },
      result.grader_results,
      [],
    );
  } catch (e) {
    return { category: 'wrong_answer', evidence: { rule: 10, category: 'wrong_answer', detail: `the failure rules raised: ${(e as Error).message}` } };
  }
}
