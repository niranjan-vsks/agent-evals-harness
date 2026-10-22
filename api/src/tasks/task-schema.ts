import { z } from 'zod';

export const GRADER_TYPES = ['exact_match', 'file_state', 'unit_test', 'trace_check', 'llm_judge'] as const;
export const TASK_CATEGORIES = [
  'memory_dependent',
  'memory_distractor',
  'neutral_deterministic',
  'neutral_judged',
  'honesty',
] as const;

const ExactMatch = z.object({
  type: z.literal('exact_match'),
  expected: z.union([z.string(), z.array(z.string()).min(1)]).nullish(),
  expected_regex: z.string().nullish(),
  normalize: z.array(z.enum(['trim', 'lowercase', 'collapse_whitespace'])).optional(),
  extract: z.literal('final_line').optional(),
});

const FileState = z.object({
  type: z.literal('file_state'),
  checks: z.array(z.record(z.string(), z.unknown())).min(1),
});

/** unit_test, trace_check and llm_judge are specified in DESIGN 7.3 and built in P2; here only their type is checked. */
const Later = z.object({ type: z.enum(['unit_test', 'trace_check', 'llm_judge']) }).passthrough();

export const GraderSpec = z.union([ExactMatch, FileState, Later]);

export const TaskFile = z
  .object({
    id: z.string().regex(/^[a-z]+-[0-9]{2}(-[a-z0-9-]+)?$/, 'id must look like det-06-ini'),
    category: z.enum(TASK_CATEGORIES),
    prompt: z.string().min(1),
    fixture_dir: z.string().nullable(),
    memory_fixture: z.string().nullable(),
    graders: z.array(GraderSpec).min(1),
    discriminates: z.array(z.enum(['memory', 'skills', 'model', 'harness'])),
    tags: z.array(z.string()),
  })
  .strict();

export type TaskFileData = z.infer<typeof TaskFile>;

/** Paths of every number in the document that is not a safe integer (task JSON allows none). */
export function findNonIntegers(value: unknown, path = '$'): string[] {
  if (typeof value === 'number') return Number.isSafeInteger(value) ? [] : [path];
  if (Array.isArray(value)) return value.flatMap((v, i) => findNonIntegers(v, `${path}[${i}]`));
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => findNonIntegers(v, `${path}.${k}`));
  }
  return [];
}
