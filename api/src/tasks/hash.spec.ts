import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readFixtureEntries } from './fixture-files';
import { memoryFixtureHash, taskHash } from './hash';
import { defaultTasksDir } from './load-tasks';

const vector = join(defaultTasksDir(), '_hashvector');
const task = JSON.parse(readFileSync(join(vector, 'task.json'), 'utf8'));
const expected = readFileSync(join(vector, 'expected.sha256'), 'utf8').trim();

describe('task hash', () => {
  it('agrees with the Python implementation on tasks/_hashvector (worker/task_hash.py wrote the expected value)', () => {
    expect(taskHash(task, readFixtureEntries(join(vector, 'fixtures')))).toBe(expected);
  });

  it('lists fixture files by POSIX path, sorted by UTF-8 bytes', () => {
    expect(readFixtureEntries(join(vector, 'fixtures')).map((e) => e.path)).toEqual(['Z.bin', 'a.txt', 'sub/b.txt']);
  });

  it('ignores a version_hash key in the task JSON', () => {
    const entries = readFixtureEntries(join(vector, 'fixtures'));
    expect(taskHash({ ...task, version_hash: 'something else' }, entries)).toBe(expected);
    const { version_hash: _removed, ...without } = task; // eslint-disable-line @typescript-eslint/no-unused-vars
    expect(taskHash(without, entries)).toBe(expected);
  });

  it('changes when the prompt changes, a fixture byte changes, or a fixture is added', () => {
    const entries = readFixtureEntries(join(vector, 'fixtures'));
    expect(taskHash({ ...task, prompt: task.prompt + ' ' }, entries)).not.toBe(expected);
    expect(taskHash(task, [{ ...entries[0], sha256: '0'.repeat(64) }, ...entries.slice(1)])).not.toBe(expected);
    expect(taskHash(task, [...entries, { path: 'extra.txt', sha256: '1'.repeat(64) }])).not.toBe(expected);
  });

  it('does not depend on the order fixture entries are supplied in', () => {
    const entries = readFixtureEntries(join(vector, 'fixtures'));
    expect(taskHash(task, [...entries].reverse())).toBe(expected);
  });

  it('does not depend on the order of keys in the task JSON', () => {
    const entries = readFixtureEntries(join(vector, 'fixtures'));
    expect(taskHash(Object.fromEntries(Object.entries(task).reverse()), entries)).toBe(expected);
  });
});

describe('memory fixture hash', () => {
  it('is a function of the sorted (filename, bytes) pairs', () => {
    const a = memoryFixtureHash({ 'MEMORY.md': 'one', 'USER.md': 'two' });
    expect(memoryFixtureHash({ 'USER.md': 'two', 'MEMORY.md': 'one' })).toBe(a);
    expect(memoryFixtureHash({ 'MEMORY.md': 'one!', 'USER.md': 'two' })).not.toBe(a);
    expect(memoryFixtureHash({ 'MEMORY.md': 'one' })).not.toBe(a);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('treats text and the same bytes as equal', () => {
    expect(memoryFixtureHash({ 'MEMORY.md': 'café' })).toBe(memoryFixtureHash({ 'MEMORY.md': Buffer.from('café', 'utf8') }));
  });
});
