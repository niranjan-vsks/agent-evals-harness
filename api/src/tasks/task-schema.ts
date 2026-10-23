import { z } from 'zod';

export const GRADER_TYPES = ['exact_match', 'file_state', 'unit_test', 'trace_check', 'llm_judge'] as const;
export const TASK_CATEGORIES = [
  'memory_dependent',
  'memory_distractor',
  'neutral_deterministic',
  'neutral_judged',
  'honesty',
] as const;

/** A path relative to the workspace or to the fixture's _hidden/ directory: no leading slash, no "..". */
const RelPath = z
  .string()
  .min(1)
  .refine((p) => !p.startsWith('/') && !/^[A-Za-z]:/.test(p) && !p.split(/[\\/]/).includes('..'), 'must be a relative path without ..');

const ExactMatch = z
  .object({
    type: z.literal('exact_match'),
    expected: z.union([z.string(), z.array(z.string()).min(1)]).nullish(),
    expected_regex: z.string().nullish(),
    normalize: z.array(z.enum(['trim', 'lowercase', 'collapse_whitespace'])).optional(),
    extract: z.literal('final_line').optional(),
  })
  .strict()
  .refine((g) => g.expected != null || g.expected_regex != null, 'exact_match needs expected or expected_regex');

const FileCheck = z.union([
  z.object({ path: RelPath, exists: z.boolean() }).strict(),
  z.object({ path: RelPath, json_path: z.string().startsWith('$'), equals: z.json() }).strict(),
  z.object({ path: RelPath, equals_file: RelPath }).strict(),
]);

const FileState = z.object({ type: z.literal('file_state'), checks: z.array(FileCheck).min(1) }).strict();

const UnitTest = z
  .object({
    type: z.literal('unit_test'),
    hidden_files: z.array(RelPath).min(1),
    command: z.string().min(1),
    timeout_seconds: z.number().int().positive(),
  })
  .strict();

const TraceAssertion = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('tool_called'), tool: z.string().min(1), args_regex: z.string().min(1).optional() }).strict(),
  z.object({ kind: z.literal('tool_not_called'), tool: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('max_steps'), value: z.number().int().min(0) }).strict(),
]);

const TraceCheck = z.object({ type: z.literal('trace_check'), assertions: z.array(TraceAssertion).min(1) }).strict();

const JudgeInput = z.union([z.literal('final_response'), z.string().regex(/^workspace_file:\S+$/, 'must be final_response or workspace_file:<path>')]);

const LlmJudge = z
  .object({
    type: z.literal('llm_judge'),
    rubric: z.array(z.object({ id: z.string().regex(/^[a-z][a-z0-9_]*$/), criterion: z.string().min(1) }).strict()).min(1),
    pass_rule: z.literal('all'),
    inputs: z.array(JudgeInput).min(1),
    judge_model_id: z.string().min(1).nullable().optional(),
  })
  .strict()
  .refine((g) => new Set(g.rubric.map((c) => c.id)).size === g.rubric.length, 'rubric ids must be unique');

export const GraderSpec = z.discriminatedUnion('type', [ExactMatch, FileState, UnitTest, TraceCheck, LlmJudge]);

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
