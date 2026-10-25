/**
 * Failure categories (P6 card section 4): a cause for every `done, passed = false` trial. Pure: the rules read the trial row, the
 * trace, the grader results and the judge labels, never a model, so the same inputs always give the same category.
 *
 * RULES is an ordered list and the first rule that returns evidence wins. Rule 10 (`wrong_answer`) always matches, so categorize
 * never fails to answer. Every rule returns the evidence it used (the trace event seq or the grader index), which the UI shows
 * the same way it shows a grader result.
 */
import { canonicalJson } from '../common/canonical-json';
import { ExitReason, GraderResultJson, TraceEventJson } from '../worker-client/types';

export const FAILURE_CATEGORIES = [
  'step_exhaustion',
  'timeout',
  'hallucinated_tool_args',
  'wrong_tool',
  'tool_error_unrecovered',
  'no_final_answer',
  'gave_up_early',
  'grader_disagreement',
  'memory_ignored',
  'wrong_answer',
] as const;
export type FailureCategory = (typeof FAILURE_CATEGORIES)[number];

export function isFailureCategory(v: unknown): v is FailureCategory {
  return typeof v === 'string' && (FAILURE_CATEGORIES as readonly string[]).includes(v);
}

/** What `trial.failure_evidence` holds: the rule that matched and the event or grader it used. */
export interface FailureEvidence {
  /** The rule's position in the card's table, 1 to 10. */
  rule: number;
  category: FailureCategory;
  /** One sentence, written for the trial page. */
  detail: string;
  /** The trace event the rule is about (the `seq` field of that event). */
  event_seq?: number;
  /** A second event the rule used, when it needs 2 (rule 3: the call that repeated the failed one). */
  related_event_seq?: number;
  grader_index?: number;
  /** Position inside a trace_check grader's assertions array (rule 4). */
  assertion_index?: number;
}

export interface FailureTrial {
  exitReason: ExitReason;
  steps: number | null;
  taskCategory: string;
  taskFixtureDir: string | null;
  memoryMode: 'off' | 'seeded';
}

export interface FailureTrace {
  events: TraceEventJson[];
  finalResponse: string | null;
  memoryInitial: Record<string, string>;
}

export type FailureGrader = Pick<GraderResultJson, 'grader_index' | 'grader_type' | 'passed' | 'details'>;

export interface FailureLabel {
  graderIndex: number;
  humanPassed: boolean;
}

export interface Categorized {
  category: FailureCategory;
  evidence: FailureEvidence;
}

interface Ctx {
  trial: FailureTrial;
  trace: FailureTrace;
  graders: readonly FailureGrader[];
  labels: readonly FailureLabel[];
}

type Hit = Omit<FailureEvidence, 'rule' | 'category'>;
interface Rule {
  rule: number;
  category: FailureCategory;
  match(ctx: Ctx): Hit | null;
}

// ---------------------------------------------------------------- rule 3 helpers

/**
 * Rule 3 patterns (card section 10, question 1): the 4 listed, case-insensitive, and the JSON parse failures a tool call can end
 * in (the minimal loop reports `error: JSONDecodeError: ...`; other harnesses word it differently).
 */
export const ARG_ERROR_PATTERNS: readonly RegExp[] = [
  /no such file/i,
  /not found/i,
  /invalid argument/i,
  /jsondecodeerror/i,
  /invalid json/i,
  /malformed json/i,
  /json (?:parse|decode)\w* (?:error|failure|failed)/i,
  /failed to parse (?:the )?(?:tool )?(?:call )?(?:arguments|json)/i,
  /expecting (?:value|property name enclosed in double quotes)/i,
  /unexpected token/i,
];
/** Added to the 4 listed by the card's default: a Python traceback in a `shell` result. */
const TRACEBACK = /Traceback/;

export function looksLikeArgError(tool: unknown, output: unknown): boolean {
  if (typeof output !== 'string') return false;
  if (ARG_ERROR_PATTERNS.some((p) => p.test(output))) return true;
  return tool === 'shell' && TRACEBACK.test(output);
}

const stepOf = (e: TraceEventJson): number => (typeof e.step === 'number' ? e.step : Number.NaN);
const isToolCall = (e: TraceEventJson) => e.kind === 'tool_call';
const isAssistantMessage = (e: TraceEventJson) => e.kind === 'message' && e.role === 'assistant';

function sameCall(a: TraceEventJson, b: TraceEventJson): boolean {
  return a.tool === b.tool && canonicalJson(a.args ?? null) === canonicalJson(b.args ?? null);
}

/**
 * The first failed call whose result looks like an argument error and whose next assistant turn sends the same tool with the
 * same args again. The next turn is the first tool_call or assistant message after the result that belongs to a later step; a
 * final answer there (no tool_call in that step) means the agent did not repeat itself.
 */
function repeatedArgError(events: readonly TraceEventJson[]): Hit | null {
  for (let i = 0; i < events.length; i++) {
    const result = events[i];
    if (result.kind !== 'tool_result' || result.is_error !== true) continue;
    const call = events.slice(0, i).reverse().find((e) => isToolCall(e) && e.call_id === result.call_id);
    if (!call || !looksLikeArgError(call.tool, result.output)) continue;
    const later = events.slice(i + 1);
    const next = later.find((e) => (isToolCall(e) || isAssistantMessage(e)) && stepOf(e) > stepOf(call));
    if (!next) continue;
    const repeat = later.find((e) => isToolCall(e) && stepOf(e) === stepOf(next) && sameCall(e, call));
    if (!repeat) continue;
    return {
      event_seq: result.seq,
      related_event_seq: repeat.seq,
      detail: `${String(call.tool)} failed with an argument error (event ${result.seq}) and the next turn sent the same call again (event ${repeat.seq})`,
    };
  }
  return null;
}

// ---------------------------------------------------------------- other helpers

const FINAL_LINE = /^[ \t>*_`-]*FINAL:[ \t]*(.+)$/m; // the exact_match grader's marker (worker/graders/exact_match.py)

const failedGraders = (ctx: Ctx, type: FailureGrader['grader_type']) => ctx.graders.filter((g) => g.grader_type === type && !g.passed);

/** The strings an exact_match grader accepted, from its stored details (`expected` is a string or a list). */
function expectedStrings(g: FailureGrader): string[] {
  const e = (g.details as { expected?: unknown }).expected;
  const list = typeof e === 'string' ? [e] : Array.isArray(e) ? e : [];
  return list.filter((s): s is string => typeof s === 'string' && s.trim() !== '');
}

const squash = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

// ---------------------------------------------------------------- the rules, in the card's order

export const RULES: readonly Rule[] = [
  {
    rule: 1,
    category: 'step_exhaustion',
    match: ({ trial }) => (trial.exitReason === 'max_steps' ? { detail: `exit_reason is max_steps (${trial.steps ?? '?'} steps)` } : null),
  },
  {
    rule: 2,
    category: 'timeout',
    match: ({ trial }) => (trial.exitReason === 'timeout' ? { detail: 'exit_reason is timeout: the runner stopped the trial' } : null),
  },
  {
    rule: 3,
    category: 'hallucinated_tool_args',
    match: ({ trace }) => repeatedArgError(trace.events),
  },
  {
    rule: 4,
    category: 'wrong_tool',
    match: (ctx) => {
      for (const g of failedGraders(ctx, 'trace_check')) {
        const list = (g.details as { assertions?: unknown }).assertions;
        if (!Array.isArray(list)) continue;
        for (let k = 0; k < list.length; k++) {
          const a = list[k] as { assertion?: { kind?: unknown }; passed?: unknown; reason?: unknown };
          const kind = a?.assertion?.kind;
          if (a?.passed === false && (kind === 'tool_called' || kind === 'tool_not_called')) {
            return { grader_index: g.grader_index, assertion_index: k, detail: `trace_check ${String(kind)} failed: ${String(a.reason ?? '')}`.trim() };
          }
        }
      }
      return null;
    },
  },
  {
    rule: 5,
    category: 'tool_error_unrecovered',
    match: ({ trace }) => {
      const last = [...trace.events].reverse().find((e) => e.kind === 'tool_result');
      return last && last.is_error === true ? { event_seq: last.seq, detail: `the last tool result (event ${last.seq}) is an error and nothing followed it` } : null;
    },
  },
  {
    rule: 6,
    category: 'no_final_answer',
    match: (ctx) => {
      const text = ctx.trace.finalResponse ?? '';
      if (text.trim() === '') return { detail: 'final_response is empty' };
      const exact = failedGraders(ctx, 'exact_match')[0];
      if (exact && !FINAL_LINE.test(text)) return { grader_index: exact.grader_index, detail: 'the answer has no FINAL: line and the exact_match grader failed' };
      return null;
    },
  },
  {
    rule: 7,
    category: 'gave_up_early',
    match: ({ trial, trace }) =>
      trial.steps !== null && trial.steps <= 2 && trial.taskFixtureDir !== null && !trace.events.some(isToolCall)
        ? { detail: `answered after ${trial.steps} step(s) without a single tool call, on a task that has a fixture to look at` }
        : null,
  },
  {
    rule: 8,
    category: 'grader_disagreement',
    match: (ctx) => {
      const judge = failedGraders(ctx, 'llm_judge').find((g) => ctx.labels.some((l) => l.graderIndex === g.grader_index && l.humanPassed));
      return judge ? { grader_index: judge.grader_index, detail: 'the llm_judge grader failed this trial and a human label says it passed' } : null;
    },
  },
  {
    rule: 9,
    category: 'memory_ignored',
    match: (ctx) => {
      const { trial, trace } = ctx;
      if (trial.taskCategory !== 'memory_dependent' || trial.memoryMode !== 'seeded') return null;
      const read = trace.events.find((e) => e.kind === 'memory_read');
      if (!read) return null;
      const seed = squash(trace.memoryInitial['MEMORY.md'] ?? '');
      const answer = squash(trace.finalResponse ?? '');
      for (const g of failedGraders(ctx, 'exact_match')) {
        // The fact must be in the seed (card section 10, question 2): if it is not, the task is at fault, not the agent.
        const wanted = expectedStrings(g).map(squash).filter((s) => seed.includes(s));
        if (wanted.length > 0 && !wanted.some((s) => answer.includes(s))) {
          return { event_seq: read.seq, grader_index: g.grader_index, detail: 'the seeded memory holds the expected answer and the response does not contain it' };
        }
      }
      return null;
    },
  },
  {
    rule: 10,
    category: 'wrong_answer',
    match: (ctx) => {
      const first = ctx.graders.find((g) => !g.passed);
      return { ...(first ? { grader_index: first.grader_index } : {}), detail: 'no earlier rule matched' };
    },
  },
];

/** First match wins. */
export function categorize(trial: FailureTrial, trace: FailureTrace, graders: readonly FailureGrader[], labels: readonly FailureLabel[] = []): Categorized {
  const ctx: Ctx = { trial, trace, graders, labels };
  for (const r of RULES) {
    const hit = r.match(ctx);
    if (hit) return { category: r.category, evidence: { rule: r.rule, category: r.category, ...hit } };
  }
  throw new Error('failures: no rule matched; rule 10 must always match'); // unreachable while RULES ends with wrong_answer
}
