import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultTasksDir, loadTasks } from './load-tasks';
import { findNonIntegers } from './task-schema';

function goodTask(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'det-01-sample',
    category: 'neutral_deterministic',
    prompt: 'p FINAL: x',
    fixture_dir: null,
    memory_fixture: null,
    graders: [{ type: 'exact_match', expected: 'x' }],
    discriminates: [],
    tags: [],
    ...over,
  };
}

function dirWith(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'tasks-'));
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), body);
  }
  return dir;
}

describe('the real tasks directory', () => {
  const result = loadTasks(defaultTasksDir());

  it('lints clean', () => {
    expect(result.errors).toEqual([]);
  });

  it('contains the 2 P1 tasks and the memory fixture, and not the hash vector', () => {
    expect(result.tasks.map((t) => t.data.id).sort()).toEqual(['det-06-ini', 'mem-01-staging-db']);
    expect(result.memoryFixtures.map((m) => m.name)).toEqual(['team-memory-v1']);
  });

  it('fits the memory fixture inside the hermes character limits', () => {
    const files = result.memoryFixtures[0].files;
    expect(files['MEMORY.md'].length).toBeLessThanOrEqual(2200);
    expect(files['USER.md'].length).toBeLessThanOrEqual(1375);
  });

  it('gives every task a 64 hex char version hash', () => {
    for (const t of result.tasks) expect(t.versionHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('tasks:lint rules', () => {
  it('accepts a valid task', () => {
    const dir = dirWith({ 'det-01-sample.json': JSON.stringify(goodTask()) });
    expect(loadTasks(dir).errors).toEqual([]);
  });

  it('rejects non-integer numbers anywhere in the task JSON', () => {
    const dir = dirWith({ 'det-01-sample.json': JSON.stringify(goodTask({ graders: [{ type: 'file_state', checks: [{ path: 'a', json_path: '$.x', equals: 1.5 }] }] })) });
    const { errors } = loadTasks(dir);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('non-integer');
    expect(errors[0]).toContain('graders[0].checks[0].equals');
  });

  it('finds floats at any depth', () => {
    expect(findNonIntegers({ a: [1, { b: 0.1 }], c: 2 })).toEqual(['$.a[1].b']);
    expect(findNonIntegers({ a: 1e21 })).toEqual(['$.a']);
  });

  it('rejects an id that does not match the file name', () => {
    const dir = dirWith({ 'det-02-other.json': JSON.stringify(goodTask()) });
    expect(loadTasks(dir).errors[0]).toContain('must match the file name');
  });

  it('rejects a bad id format, an empty graders array and unknown keys', () => {
    const dir = dirWith({
      'Bad.json': JSON.stringify(goodTask({ id: 'Bad' })),
      'det-03-empty.json': JSON.stringify(goodTask({ id: 'det-03-empty', graders: [] })),
      'det-04-extra.json': JSON.stringify(goodTask({ id: 'det-04-extra', surprise: 1 })),
    });
    expect(loadTasks(dir).errors).toHaveLength(3);
  });

  it('rejects an unknown grader type and an exact_match typo', () => {
    const dir = dirWith({ 'det-01-sample.json': JSON.stringify(goodTask({ graders: [{ type: 'vibes' }] })) });
    expect(loadTasks(dir).errors.length).toBeGreaterThan(0);
  });

  it('rejects a missing fixture dir, a missing memory fixture and a fixture dir that escapes', () => {
    const dir = dirWith({
      'det-01-sample.json': JSON.stringify(goodTask({ fixture_dir: 'fixtures/nope' })),
      'det-02-mem.json': JSON.stringify(goodTask({ id: 'det-02-mem', memory_fixture: 'absent' })),
      'det-03-out.json': JSON.stringify(goodTask({ id: 'det-03-out', fixture_dir: '..' })),
    });
    const messages = loadTasks(dir).errors.join('\n');
    expect(messages).toContain('does not exist');
    expect(messages).toContain('not found under tasks/memory');
    expect(messages).toContain('escapes');
  });

  it('reports invalid JSON', () => {
    expect(loadTasks(dirWith({ 'det-01-sample.json': '{nope' })).errors[0]).toContain('not valid JSON');
  });

  it('hashes the fixture tree: a changed fixture byte is a new version', () => {
    const files = { 'det-01-sample.json': JSON.stringify(goodTask({ fixture_dir: 'fixtures/a' })), 'fixtures/a/f.txt': 'one' };
    const a = loadTasks(dirWith(files)).tasks[0].versionHash;
    const b = loadTasks(dirWith({ ...files, 'fixtures/a/f.txt': 'two' })).tasks[0].versionHash;
    expect(a).not.toBe(b);
  });
});

describe('tasks:lint rules for the 5 grader types', () => {
  const unitTest = { type: 'unit_test', hidden_files: ['tests/test_a.py'], command: 'python -m pytest -q tests/test_a.py', timeout_seconds: 60 };
  const judge = {
    type: 'llm_judge',
    rubric: [
      { id: 'c1', criterion: 'names the root cause' },
      { id: 'c2', criterion: 'names the fix' },
    ],
    pass_rule: 'all',
    inputs: ['final_response', 'workspace_file:NOTES_OUT.md'],
    judge_model_id: null,
  };

  function lint(over: Record<string, unknown>, files: Record<string, string> = {}): string[] {
    const id = (over.id as string | undefined) ?? 'det-01-sample';
    return loadTasks(dirWith({ [`${id}.json`]: JSON.stringify(goodTask(over)), ...files })).errors;
  }

  it('accepts a unit_test whose hidden file exists under _hidden/', () => {
    const errors = lint({ fixture_dir: 'fixtures/a', graders: [unitTest] }, { 'fixtures/a/_hidden/tests/test_a.py': 'def test_x(): pass' });
    expect(errors).toEqual([]);
  });

  it('rejects a unit_test whose hidden file is missing, or sits outside _hidden/ where the agent could see it', () => {
    const missing = lint({ fixture_dir: 'fixtures/a', graders: [unitTest] }, { 'fixtures/a/keep.txt': 'x' });
    expect(missing.join(' | ')).toContain('hidden file "tests/test_a.py" is not a file under _hidden/');
    const visible = lint({ fixture_dir: 'fixtures/a', graders: [unitTest] }, { 'fixtures/a/tests/test_a.py': 'def test_x(): pass' });
    expect(visible.join(' | ')).toContain('not a file under _hidden/');
    expect(lint({ graders: [unitTest] }).join(' | ')).toContain('not a file under _hidden/');
  });

  it('rejects paths that leave the directory', () => {
    expect(lint({ graders: [{ ...unitTest, hidden_files: ['../x.py'] }] }).length).toBeGreaterThan(0);
    expect(lint({ graders: [{ ...unitTest, hidden_files: ['/etc/passwd'] }] }).length).toBeGreaterThan(0);
    expect(lint({ graders: [{ type: 'file_state', checks: [{ path: '..\\x', exists: true }] }] }).length).toBeGreaterThan(0);
  });

  it('checks equals_file the same way', () => {
    const grader = { type: 'file_state', checks: [{ path: 'sorted.txt', equals_file: 'expected/sorted.txt' }] };
    expect(lint({ fixture_dir: 'fixtures/a', graders: [grader] }, { 'fixtures/a/_hidden/expected/sorted.txt': '1' })).toEqual([]);
    expect(lint({ fixture_dir: 'fixtures/a', graders: [grader] }, { 'fixtures/a/other.txt': '1' }).join(' | ')).toContain('equals_file');
  });

  it('wants a file_state check to say what it compares', () => {
    expect(lint({ graders: [{ type: 'file_state', checks: [{ path: 'a.json', json_path: '$.x' }] }] }).length).toBeGreaterThan(0);
    expect(lint({ graders: [{ type: 'file_state', checks: [{ path: 'a.json' }] }] }).length).toBeGreaterThan(0);
    expect(lint({ graders: [{ type: 'file_state', checks: [{ path: 'a.json', json_path: '$.x', equals: 1 }] }] })).toEqual([]);
  });

  it('requires FINAL: in the prompt of an exact_match task', () => {
    expect(lint({ prompt: 'What is the port?' }).join(' | ')).toContain('FINAL:');
    expect(lint({ prompt: 'What is the port? Finish with FINAL: <port>.' })).toEqual([]);
  });

  it('requires a memory fixture and the memory axis for the memory categories', () => {
    const errors = lint({ category: 'memory_dependent', prompt: 'p FINAL: x' }).join(' | ');
    expect(errors).toContain('needs a memory_fixture');
    expect(errors).toContain('"memory" in discriminates');
    const withFixture = loadTasks(
      dirWith({
        'det-01-sample.json': JSON.stringify(goodTask({ category: 'memory_distractor', prompt: 'p FINAL: x', memory_fixture: 'm', discriminates: ['memory'] })),
        'memory/m/MEMORY.md': 'x',
      }),
    ).errors;
    expect(withFixture).toEqual([]);
  });

  it('validates a trace_check', () => {
    const ok = { type: 'trace_check', assertions: [{ kind: 'tool_called', tool: 'shell', args_regex: '--strict' }, { kind: 'max_steps', value: 10 }] };
    expect(lint({ graders: [ok] })).toEqual([]);
    expect(lint({ graders: [{ type: 'trace_check', assertions: [{ kind: 'tool_called' }] }] }).length).toBeGreaterThan(0);
    expect(lint({ graders: [{ type: 'trace_check', assertions: [{ kind: 'vibes', tool: 'shell' }] }] }).length).toBeGreaterThan(0);
    expect(lint({ graders: [{ type: 'trace_check', assertions: [] }] }).length).toBeGreaterThan(0);
  });

  it('validates an llm_judge: unique rubric ids, known inputs, and an output file the prompt names', () => {
    expect(lint({ prompt: 'Write NOTES_OUT.md', graders: [judge] })).toEqual([]);
    expect(lint({ prompt: 'Write the notes', graders: [judge] }).join(' | ')).toContain('never names');
    const dup = { ...judge, rubric: [judge.rubric[0], judge.rubric[0]] };
    expect(lint({ prompt: 'Write NOTES_OUT.md', graders: [dup] }).join(' | ')).toContain('unique');
    expect(lint({ prompt: 'Write NOTES_OUT.md', graders: [{ ...judge, inputs: ['trajectory'] }] }).length).toBeGreaterThan(0);
    expect(lint({ prompt: 'Write NOTES_OUT.md', graders: [{ ...judge, pass_rule: 'any' }] }).length).toBeGreaterThan(0);
  });

  it('rejects a misspelled key in any grader instead of ignoring it', () => {
    expect(lint({ graders: [{ type: 'exact_match', expecetd: 'x' }] }).length).toBeGreaterThan(0);
    expect(lint({ graders: [{ ...unitTest, timeout: 5 }] }).length).toBeGreaterThan(0);
  });

  it('keeps the grader files out of the prompt', () => {
    expect(lint({ prompt: 'Look in _hidden/ FINAL: x' }).join(' | ')).toContain('_hidden');
  });
});
