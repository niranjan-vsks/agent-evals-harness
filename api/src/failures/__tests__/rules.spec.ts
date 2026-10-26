import { TraceEventJson } from '../../worker-client/types';
import { categorize, FailureGrader, FailureLabel, FailureTrace, FailureTrial, FAILURE_CATEGORIES, RULES, WRONG_ANSWER_RULE } from '../rules';

/**
 * 1 positive and 1 negative synthetic trace per category. A negative is the nearest case that must NOT get the category, so a
 * rule that is too wide fails here. Traces are written by hand in the shape the adapters emit (ADAPTERS.md section 1).
 */

type Part = Omit<TraceEventJson, 'seq' | 't_ms'>;
const build = (parts: Part[]): TraceEventJson[] => parts.map((p, i) => ({ ...p, seq: i, t_ms: i * 10 }) as TraceEventJson);

const user = (content = 'Do the task.'): Part => ({ kind: 'message', role: 'user', content, step: 0 });
const api = (step: number): Part => ({ kind: 'api_call', step, model: 'm', status: 'ok', http_status: 200, input_tokens: 10, output_tokens: 5, latency_ms: 1 });
const call = (step: number, id: string, tool: string, args: Record<string, unknown>): Part => ({ kind: 'tool_call', step, call_id: id, tool, harness_tool: tool, args });
const result = (id: string, output: string, isError = false): Part => ({ kind: 'tool_result', call_id: id, output, is_error: isError, duration_ms: 1 });
const answer = (step: number, content: string): Part => ({ kind: 'message', role: 'assistant', content, step });
const memoryRead = (): Part => ({ kind: 'memory_read', file: 'MEMORY.md', content: 'x', loaded_by: 'harness' });

const trial = (o: Partial<FailureTrial> = {}): FailureTrial => ({
  exitReason: 'completed',
  steps: 4,
  taskCategory: 'neutral_deterministic',
  taskFixtureDir: 'fixtures/t',
  memoryMode: 'off',
  ...o,
});
const trace = (parts: Part[], finalResponse: string | null = 'FINAL: 7', memoryInitial: Record<string, string> = {}): FailureTrace => ({
  events: build(parts),
  finalResponse,
  memoryInitial,
});
const exact = (index = 0, expected: string | string[] = '42', passed = false): FailureGrader => ({
  grader_index: index,
  grader_type: 'exact_match',
  passed,
  details: { expected, extracted: 'x' },
});
const fileState = (index = 0, passed = false): FailureGrader => ({ grader_index: index, grader_type: 'file_state', passed, details: {} });
const traceCheck = (index: number, assertions: Array<{ kind: string; passed: boolean; reason?: string }>): FailureGrader => ({
  grader_index: index,
  grader_type: 'trace_check',
  passed: assertions.every((a) => a.passed),
  details: { assertions: assertions.map((a) => ({ assertion: { kind: a.kind }, passed: a.passed, reason: a.reason ?? '' })) },
});
const judge = (index: number, passed = false, criteria?: Array<{ id: string; met: boolean }>): FailureGrader => ({
  grader_index: index,
  grader_type: 'llm_judge',
  passed,
  details: criteria ? { criteria } : {},
});

/** A run that looked at the fixture, answered with a FINAL line and was simply wrong: the shape that must stay `wrong_answer`. */
const plainWrong = (): Part[] => [user(), api(1), call(1, 'a', 'files', { path: '.' }), result('a', 'data.csv'), api(2), answer(2, 'FINAL: 7')];

describe('rule 1: step_exhaustion', () => {
  it('matches exit_reason max_steps', () => {
    const r = categorize(trial({ exitReason: 'max_steps', steps: 15 }), trace(plainWrong()), [exact()]);
    expect(r.category).toBe('step_exhaustion');
    expect(r.evidence).toMatchObject({ rule: 1, category: 'step_exhaustion' });
  });
  it('does not match a completed run that used many steps', () => {
    expect(categorize(trial({ exitReason: 'completed', steps: 15 }), trace(plainWrong()), [exact()]).category).toBe('wrong_answer');
  });
  it('comes before every later rule: a max_steps run that ends on a tool error is still step_exhaustion', () => {
    const t = trace([user(), api(1), call(1, 'a', 'shell', { command: 'x' }), result('a', 'permission denied', true)], '');
    expect(categorize(trial({ exitReason: 'max_steps' }), t, [exact()]).category).toBe('step_exhaustion');
  });
});

describe('rule 2: timeout', () => {
  it('matches exit_reason timeout', () => {
    const r = categorize(trial({ exitReason: 'timeout' }), trace(plainWrong(), null), [exact()]);
    expect(r.category).toBe('timeout');
    expect(r.evidence.rule).toBe(2);
  });
  it('does not match an agent_error, however long the trace', () => {
    expect(categorize(trial({ exitReason: 'agent_error', steps: 15 }), trace(plainWrong()), [exact()]).category).toBe('wrong_answer');
  });
});

describe('rule 3: hallucinated_tool_args', () => {
  const missing = 'cat: nope.txt: No such file or directory';
  it('matches an argument error that the next turn repeats with the same args', () => {
    const parts = [
      user(),
      api(1),
      call(1, 'a', 'shell', { command: 'cat nope.txt' }),
      result('a', missing, true),
      api(2),
      call(2, 'b', 'shell', { command: 'cat nope.txt' }),
      result('b', missing, true),
      api(3),
      answer(3, 'FINAL: 7'),
    ];
    const r = categorize(trial(), trace(parts), [exact()]);
    expect(r.category).toBe('hallucinated_tool_args');
    expect(r.evidence).toMatchObject({ rule: 3, event_seq: 3, related_event_seq: 5 }); // the first error result and the repeated call
  });
  it('matches when the args differ only in key order', () => {
    const parts = [
      user(),
      api(1),
      call(1, 'a', 'files', { path: 'nope.txt', limit: 5 }),
      result('a', '{"error": "file not found"}', true),
      api(2),
      call(2, 'b', 'files', { limit: 5, path: 'nope.txt' }),
      result('b', 'ok'),
      api(3),
      answer(3, 'FINAL: 7'),
    ];
    expect(categorize(trial(), trace(parts), [exact()]).category).toBe('hallucinated_tool_args');
  });
  it('matches a traceback in a shell result, and a JSON decode error', () => {
    const tb = [user(), api(1), call(1, 'a', 'shell', { command: 'python x.py' }), result('a', 'Traceback (most recent call last):\n  File "x.py"', true), api(2), call(2, 'b', 'shell', { command: 'python x.py' }), result('b', 'ok')];
    expect(categorize(trial(), trace(tb), [exact()]).category).toBe('hallucinated_tool_args');
    const js = [user(), api(1), call(1, 'a', 'files', { raw: '{' }), result('a', 'error: JSONDecodeError: Expecting value', true), api(2), call(2, 'b', 'files', { raw: '{' }), result('b', 'ok')];
    expect(categorize(trial(), trace(js), [exact()]).category).toBe('hallucinated_tool_args');
  });
  it('does not match when the next turn changes the args (the agent corrected itself)', () => {
    const parts = [
      user(),
      api(1),
      call(1, 'a', 'shell', { command: 'cat nope.txt' }),
      result('a', missing, true),
      api(2),
      call(2, 'b', 'shell', { command: 'cat data.txt' }),
      result('b', '7'),
      api(3),
      answer(3, 'FINAL: 7'),
    ];
    expect(categorize(trial(), trace(parts), [exact()]).category).toBe('wrong_answer');
  });
  it('does not match when the next turn is the final answer, or the error is not an argument error', () => {
    const answered = [user(), api(1), call(1, 'a', 'shell', { command: 'cat nope.txt' }), result('a', missing, true), api(2), answer(2, 'FINAL: 7')];
    // No repeat, so not rule 3; the error was the last tool result, so rule 5 takes it.
    expect(categorize(trial(), trace(answered), [exact()]).category).toBe('tool_error_unrecovered');
    const denied = [
      user(),
      api(1),
      call(1, 'a', 'shell', { command: 'ls /root' }),
      result('a', 'permission denied', true),
      api(2),
      call(2, 'b', 'shell', { command: 'ls /root' }),
      result('b', 'permission denied', true),
    ];
    // Same repeat, but "permission denied" is not an argument error: the run ends on an unrecovered tool error instead.
    expect(categorize(trial(), trace(denied), [exact()]).category).toBe('tool_error_unrecovered');
  });
  it('does not match a repeat of a call whose first attempt succeeded', () => {
    const parts = [user(), api(1), call(1, 'a', 'shell', { command: 'ls' }), result('a', 'No such file or directory in the listing'), api(2), call(2, 'b', 'shell', { command: 'ls' }), result('b', 'x'), api(3), answer(3, 'FINAL: 7')];
    expect(categorize(trial(), trace(parts), [exact()]).category).toBe('wrong_answer');
  });
});

describe('rule 4: wrong_tool_usage', () => {
  it('matches a failed trace_check tool_called assertion, and points at the assertion', () => {
    const g = traceCheck(1, [
      { kind: 'tool_called', passed: false, reason: '0 call(s) of shell' },
      { kind: 'max_steps', passed: true },
    ]);
    const r = categorize(trial(), trace(plainWrong()), [exact(0, 'FAIL', true), g]);
    expect(r.category).toBe('wrong_tool_usage');
    expect(r.evidence).toMatchObject({ rule: 4, grader_index: 1, assertion_index: 0 });
  });
  it('matches a failed tool_not_called assertion', () => {
    const g = traceCheck(0, [{ kind: 'tool_not_called', passed: false }]);
    expect(categorize(trial(), trace(plainWrong()), [g]).category).toBe('wrong_tool_usage');
  });
  it('does not match a trace_check that failed only on max_steps', () => {
    const g = traceCheck(0, [
      { kind: 'tool_called', passed: true },
      { kind: 'max_steps', passed: false },
    ]);
    expect(categorize(trial(), trace(plainWrong()), [g]).category).toBe('wrong_answer');
  });
  it('does not match when the trace_check passed and another grader failed', () => {
    const g = traceCheck(1, [{ kind: 'tool_called', passed: true }]);
    expect(categorize(trial(), trace(plainWrong()), [exact(0), g]).category).toBe('wrong_answer');
  });
});

describe('rule 5: tool_error_unrecovered', () => {
  it('matches when the last tool result is an error', () => {
    const parts = [user(), api(1), call(1, 'a', 'shell', { command: 'ls /root' }), result('a', 'permission denied', true), api(2), answer(2, 'FINAL: 7')];
    const r = categorize(trial(), trace(parts), [exact()]);
    expect(r.category).toBe('tool_error_unrecovered');
    expect(r.evidence).toMatchObject({ rule: 5, event_seq: 3 });
  });
  it('does not match when a later tool call succeeded', () => {
    const parts = [
      user(),
      api(1),
      call(1, 'a', 'shell', { command: 'ls /root' }),
      result('a', 'permission denied', true),
      api(2),
      call(2, 'b', 'shell', { command: 'ls' }),
      result('b', 'data.csv'),
      api(3),
      answer(3, 'FINAL: 7'),
    ];
    expect(categorize(trial(), trace(parts), [exact()]).category).toBe('wrong_answer');
  });
  it('does not match a trace with no tool result at all', () => {
    const parts = [user(), api(1), answer(1, 'FINAL: 7')];
    expect(categorize(trial({ taskFixtureDir: null }), trace(parts), [exact()]).category).toBe('wrong_answer');
  });
  describe('the output must read as an error, not only carry is_error', () => {
    const lastResult = (output: string) => [user(), api(1), call(1, 'a', 'shell', { command: 'grep x f' }), result('a', output, true), api(2), answer(2, 'FINAL: 7')];
    const cat = (output: string) => categorize(trial(), trace(lastResult(output)), [exact()]).category;

    it('a grep that found nothing is not an error, however Hermes flags it', () => {
      const noMatch = '{"output": "", "exit_code": 1, "error": null, "exit_code_meaning": "No matches found (not an error)"}';
      expect(cat(noMatch)).toBe('wrong_answer');
    });
    it('a non-zero exit with output and "error": null is not an error either (a lint finding)', () => {
      expect(cat('{"output": "src/app.py:9: line too long (123 > 79)\\nFAIL", "exit_code": 1, "error": null}')).toBe('wrong_answer');
    });
    it('matches the outputs real tools give when they fail', () => {
      for (const output of [
        '{"content": "", "total_lines": 0, "error": "Cannot read the path: not a regular file", "not_found": false}',
        '{"total_count": 0, "error": "Path not found: docs"}',
        '{"output": "Traceback (most recent call last):\\n  File <stdin>, line 3\\nIndexError: list index out of range", "exit_code": 1, "error": null}',
        '{"output": "/usr/bin/bash: line 5: file: command not found", "exit_code": 127, "error": null}',
        '{"output": "ls: cannot access /etc/cron.d: No such file or directory", "exit_code": 2, "error": null}',
        "error: unknown tool 'shell'",
        'error: FileNotFoundError: No such file or directory',
      ]) {
        expect(cat(output)).toBe('tool_error_unrecovered');
      }
    });
    it('a result without is_error is never this category, whatever it says', () => {
      const parts = [user(), api(1), call(1, 'a', 'shell', { command: 'x' }), result('a', 'error: boom', false), api(2), answer(2, 'FINAL: 7')];
      expect(categorize(trial(), trace(parts), [exact()]).category).toBe('wrong_answer');
    });
  });
});

describe('rule 6: no_final_answer', () => {
  it('matches an empty final_response, and a null one', () => {
    expect(categorize(trial(), trace(plainWrong(), ''), [fileState()]).category).toBe('no_final_answer');
    expect(categorize(trial(), trace(plainWrong(), null), [fileState()]).category).toBe('no_final_answer');
    expect(categorize(trial(), trace(plainWrong(), '  \n'), [fileState()]).evidence.detail).toBe('final_response is empty');
  });
  it('matches a reply without a FINAL: line when the exact_match grader failed', () => {
    const r = categorize(trial(), trace(plainWrong(), "I could not find it. Let me know if you want me to look elsewhere."), [exact(2)]);
    expect(r.category).toBe('no_final_answer');
    expect(r.evidence).toMatchObject({ rule: 6, grader_index: 2 });
  });
  it('accepts the FINAL: line the way the grader does (bold, quoted, indented)', () => {
    for (const text of ['**FINAL: 7**', '> FINAL: 7', 'text\nFINAL: 7', '`FINAL: 7`']) {
      expect(categorize(trial(), trace(plainWrong(), text), [exact()]).category).toBe('wrong_answer');
    }
  });
  it('does not match a non-empty reply without FINAL: on a task that has no exact_match grader', () => {
    expect(categorize(trial(), trace(plainWrong(), 'I edited the file.'), [fileState()]).category).toBe('wrong_answer');
  });
  it('does not match when the exact_match grader passed and another grader failed', () => {
    expect(categorize(trial(), trace(plainWrong(), 'FAIL'), [exact(0, 'FAIL', true), fileState(1)]).category).toBe('wrong_answer');
  });
});

describe('rule 7: gave_up_early', () => {
  const noLook = [user(), api(1), answer(1, 'I do not know.')];
  it('matches at most 2 steps, no tool call and a fixture', () => {
    const r = categorize(trial({ steps: 1 }), trace(noLook, 'FINAL: 7'), [exact()]);
    expect(r.category).toBe('gave_up_early');
    expect(r.evidence.rule).toBe(7);
    expect(categorize(trial({ steps: 2 }), trace(noLook, 'FINAL: 7'), [exact()]).category).toBe('gave_up_early');
  });
  it('does not match when the task has no fixture to look at', () => {
    expect(categorize(trial({ steps: 1, taskFixtureDir: null }), trace(noLook, 'FINAL: 7'), [exact()]).category).toBe('wrong_answer');
  });
  it('does not match at 3 steps', () => {
    expect(categorize(trial({ steps: 3 }), trace(noLook, 'FINAL: 7'), [exact()]).category).toBe('wrong_answer');
  });
  it('does not match when the agent made a tool call', () => {
    const looked = [user(), api(1), call(1, 'a', 'files', { path: '.' }), result('a', 'x'), api(2), answer(2, 'FINAL: 7')];
    expect(categorize(trial({ steps: 2 }), trace(looked, 'FINAL: 7'), [exact()]).category).toBe('wrong_answer');
  });
});

describe('rule 8: judge_criteria_unmet', () => {
  const labels = (humanPassed: boolean, graderIndex = 1): FailureLabel[] => [{ graderIndex, humanPassed }];
  it('matches a failed llm_judge with no label, and names the criteria it did not meet', () => {
    const j = judge(1, false, [
      { id: 'c1', met: true },
      { id: 'c2', met: false },
      { id: 'c3', met: false },
    ]);
    const r = categorize(trial(), trace(plainWrong(), 'a summary'), [fileState(0, true), j], []);
    expect(r.category).toBe('judge_criteria_unmet');
    expect(r.evidence).toMatchObject({ rule: 8, grader_index: 1 });
    expect(r.evidence.detail).toBe('the llm_judge grader failed: criteria c2, c3 not met');
  });
  it('matches when the judge agrees with the human label, and when the judge records no criteria', () => {
    expect(categorize(trial(), trace(plainWrong(), 'a bad summary'), [judge(1)], labels(false)).category).toBe('judge_criteria_unmet');
    expect(categorize(trial(), trace(plainWrong()), [judge(1)], []).evidence.detail).toBe('the llm_judge grader failed and records no unmet criterion');
  });
  it('does not match when a human label says the trial passed (that is grader_disagreement, next)', () => {
    expect(categorize(trial(), trace(plainWrong(), 'a good summary'), [judge(1)], labels(true)).category).toBe('grader_disagreement');
  });
  it('does not match when the judge passed, or when there is no llm_judge grader', () => {
    expect(categorize(trial(), trace(plainWrong()), [judge(1, true), fileState(0)], []).category).toBe('wrong_answer');
    expect(categorize(trial(), trace(plainWrong()), [fileState(0)], []).category).toBe('wrong_answer');
  });
  it('comes after the rules for a missing answer: an empty reply to a judged task is no_final_answer', () => {
    expect(categorize(trial(), trace(plainWrong(), ''), [judge(1)], []).category).toBe('no_final_answer');
  });
});

describe('rule 9: grader_disagreement', () => {
  const labels = (humanPassed: boolean, graderIndex = 1): FailureLabel[] => [{ graderIndex, humanPassed }];
  it('matches a failed llm_judge whose human label says passed', () => {
    const r = categorize(trial(), trace(plainWrong(), 'a good summary'), [fileState(0, true), judge(1)], labels(true));
    expect(r.category).toBe('grader_disagreement');
    expect(r.evidence).toMatchObject({ rule: 9, grader_index: 1 });
  });
  it('does not match when the human agrees with the judge (judge_criteria_unmet takes it)', () => {
    expect(categorize(trial(), trace(plainWrong(), 'a bad summary'), [judge(1)], labels(false)).category).toBe('judge_criteria_unmet');
  });
  it('does not match a label that sits on a grader that did not fail', () => {
    expect(categorize(trial(), trace(plainWrong()), [judge(1, true), judge(2, true)], labels(true, 2)).category).toBe('wrong_answer');
  });
  it('does not match when the judge passed and a different grader failed', () => {
    expect(categorize(trial(), trace(plainWrong()), [judge(1, true), fileState(0)], labels(true)).category).toBe('wrong_answer');
  });
});

describe('rule 10: memory_ignored', () => {
  const seed = { 'MEMORY.md': 'Service owners: ingest is owned by Marco, billing by Priya.\n§\nStaging: pg-stage-07.internal:6432' };
  const memTrial = (o: Partial<FailureTrial> = {}) => trial({ taskCategory: 'memory_dependent', memoryMode: 'seeded', taskFixtureDir: null, ...o });
  const run = [user(), memoryRead(), api(1), answer(1, 'FINAL: Priya')];
  it('matches a seeded memory task whose response lacks an answer the seed holds', () => {
    const r = categorize(memTrial(), trace(run, 'FINAL: Priya', seed), [exact(0, 'Marco')]);
    expect(r.category).toBe('memory_ignored');
    expect(r.evidence).toMatchObject({ rule: 10, event_seq: 1, grader_index: 0 });
  });
  it('compares case-insensitively and across whitespace', () => {
    const r = categorize(memTrial(), trace(run, 'FINAL: nope', seed), [exact(0, ['PG-STAGE-07.internal:6432'])]);
    expect(r.category).toBe('memory_ignored');
  });
  it('does not match when memory is off', () => {
    expect(categorize(memTrial({ memoryMode: 'off' }), trace(run, 'FINAL: Priya', seed), [exact(0, 'Marco')]).category).toBe('wrong_answer');
  });
  it('does not match when the expected string is not in the seed (the task is at fault)', () => {
    expect(categorize(memTrial(), trace(run, 'FINAL: Priya', seed), [exact(0, 'Tomasz')]).category).toBe('wrong_answer');
  });
  it('does not match when the response contains the expected string', () => {
    expect(categorize(memTrial(), trace(run, 'FINAL: Marco and Priya', seed), [exact(0, 'Marco')]).category).toBe('wrong_answer');
  });
  it('does not match without a memory_read event, or on another task category', () => {
    const noRead = [user(), api(1), answer(1, 'FINAL: Priya')];
    expect(categorize(memTrial(), trace(noRead, 'FINAL: Priya', seed), [exact(0, 'Marco')]).category).toBe('wrong_answer');
    expect(categorize(memTrial({ taskCategory: 'memory_distractor' }), trace(run, 'FINAL: Priya', seed), [exact(0, 'Marco')]).category).toBe('wrong_answer');
  });
  it('does not match a task with no exact_match grader (there is no expected string to look for)', () => {
    expect(categorize(memTrial(), trace(run, 'FINAL: Priya', seed), [fileState(0)]).category).toBe('wrong_answer');
  });
});

describe('rule 11: abstained', () => {
  const said = (text: string, over: Partial<FailureTrial> = {}, graders: FailureGrader[] = [fileState()]) =>
    categorize(trial({ taskFixtureDir: null, steps: 4, ...over }), trace(plainWrong(), text), graders);
  it('matches the replies the P5 agents gave when they did not know, and ones that ask the user', () => {
    for (const text of [
      'I don’t have that information in the current workspace.  \nFINAL: Unknown',
      "The ownership of the ingest service isn't documented in the current repository.",
      "Could you provide the exact JSON content you'd like in config.json?",
      'I’m not sure what the team’s standard configuration looks like. Could you provide the desired contents?',
      'I cannot determine the host from the files I can see.',
      'FINAL: unknown',
      'What should the config contain?',
    ]) {
      const r = said(text);
      expect(r.category).toBe('abstained');
      expect(r.evidence.rule).toBe(11);
    }
  });
  it('points at the last assistant message', () => {
    const r = categorize(trial({ taskFixtureDir: null }), trace(plainWrong(), "I don't know."), [fileState()]);
    expect(r.evidence).toMatchObject({ event_seq: 5 }); // plainWrong() ends with the assistant message at seq 5
  });
  it('does not match a confident wrong answer, a finished action, or a reply that only mentions what it did not change', () => {
    for (const text of ['FINAL: 5', 'Renamed all .txt files to .md.', "I didn't change the file contents; the files are renamed.", 'RELEASE.md created with the release checklist.']) {
      expect(said(text).category).toBe('wrong_answer');
    }
  });
  it('does not match when the agent went on to call a tool after saying it', () => {
    const parts = [user(), api(1), answer(1, "I don't know. Let me look."), api(2), call(2, 'a', 'files', { path: '.' }), result('a', 'data.csv'), api(3)];
    expect(categorize(trial({ taskFixtureDir: null }), trace(parts, "I don't know."), [fileState()]).category).toBe('wrong_answer');
  });
  it('comes after the missing-answer rule and after memory_ignored', () => {
    expect(said('Which ingest service are you referring to?', {}, [exact()]).category).toBe('no_final_answer'); // exact_match failed, no FINAL line
    const seed = { 'MEMORY.md': 'ingest is owned by Marco' };
    const run = [user(), memoryRead(), api(1), answer(1, "I don't know.")];
    const r = categorize(trial({ taskCategory: 'memory_dependent', memoryMode: 'seeded', taskFixtureDir: null }), trace(run, "FINAL: I don't know", seed), [exact(0, 'Marco')]);
    expect(r.category).toBe('memory_ignored');
  });
  it('comes after judge_criteria_unmet: a judged task whose reply ends with a question is a missed rubric', () => {
    expect(said('Should I add a test?', {}, [judge(0, false, [{ id: 'c1', met: false }])]).category).toBe('judge_criteria_unmet');
  });
});

describe('rule 12: wrong_answer', () => {
  it('is what is left, and names the first failed grader', () => {
    const r = categorize(trial(), trace(plainWrong()), [exact(0, '42', true), fileState(1)]);
    expect(r.category).toBe('wrong_answer');
    expect(r.evidence).toMatchObject({ rule: 12, grader_index: 1 });
  });
  it('is not given to a trial an earlier rule explains', () => {
    expect(categorize(trial({ exitReason: 'timeout' }), trace(plainWrong()), [exact()]).category).not.toBe('wrong_answer');
  });
});

describe('the rule table', () => {
  it('has 12 rules, the card order plus the 2 added ones, ending with the rule that always matches', () => {
    expect(RULES.map((r) => r.category)).toEqual([...FAILURE_CATEGORIES]);
    expect(RULES.map((r) => r.rule)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });
  it('WRONG_ANSWER_RULE is the number RULES gives the wrong_answer rule, which is the one that always matches', () => {
    expect(WRONG_ANSWER_RULE).toBe(RULES.find((r) => r.category === 'wrong_answer')!.rule);
    expect(WRONG_ANSWER_RULE).toBe(RULES[RULES.length - 1].rule);
    expect(WRONG_ANSWER_RULE).toBe(12);
    // and it is what categorize() itself reports for a failure nothing else explains
    expect(categorize(trial(), trace(plainWrong()), [exact()]).evidence.rule).toBe(WRONG_ANSWER_RULE);
  });
  it('is deterministic and does not change its inputs', () => {
    const tr = trace(plainWrong());
    const before = JSON.stringify(tr);
    const a = categorize(trial(), tr, [exact()]);
    const b = categorize(trial(), tr, [exact()]);
    expect(a).toEqual(b);
    expect(JSON.stringify(tr)).toBe(before);
  });
});
