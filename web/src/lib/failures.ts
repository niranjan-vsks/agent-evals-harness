// Display strings for the failure categories (api/src/failures/rules.ts). The category itself is decided by the API's rules over the
// trace and the grader results; nothing here assigns or recomputes one. The order is the order of the rules (first match wins).
import type { FailureCategory } from '../api/types';

export const FAILURE_CATEGORIES: readonly FailureCategory[] = [
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
];

export const FAILURE_RULE: Record<FailureCategory, string> = {
  step_exhaustion: 'the harness stopped the run at its step limit (exit reason max_steps)',
  timeout: 'the runner stopped the run at its time limit (exit reason timeout)',
  hallucinated_tool_args: 'a tool call failed on its arguments (missing file, bad JSON, traceback) and the next turn sent the same call again',
  wrong_tool: 'a trace check on which tool was, or was not, called failed',
  tool_error_unrecovered: 'the last tool result was an error and nothing came after it',
  no_final_answer: 'the final response is empty, or has no FINAL line where an exact match was graded',
  gave_up_early: 'answered within 2 steps without any tool call, on a task that has files to look at',
  grader_disagreement: 'the LLM judge failed the trial and a human label says it passed',
  memory_ignored: 'the seeded memory holds the expected answer and the final response does not contain it',
  wrong_answer: 'none of the rules above matched: the answer was simply wrong',
};
