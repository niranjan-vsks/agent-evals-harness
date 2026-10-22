import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultTasksDir, loadTasks } from './load-tasks';
import { findNonIntegers } from './task-schema';

function goodTask(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'det-01-sample',
    category: 'neutral_deterministic',
    prompt: 'p',
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
