import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import { readFixtureEntries } from './fixture-files';
import { memoryFixtureHash, taskHash } from './hash';
import { lintTask } from './lint-rules';
import { findNonIntegers, TaskFile, TaskFileData } from './task-schema';

export interface LoadedTask {
  data: TaskFileData;
  versionHash: string;
  file: string;
}

export interface LoadedMemoryFixture {
  name: string;
  hash: string;
  files: Record<string, string>;
}

export interface LoadResult {
  tasks: LoadedTask[];
  memoryFixtures: LoadedMemoryFixture[];
  errors: string[];
}

export function defaultTasksDir(): string {
  return process.env.TASKS_DIR ?? resolve(process.cwd(), '..', 'tasks');
}

export function loadMemoryFixtures(tasksDir: string): LoadedMemoryFixture[] {
  const root = join(tasksDir, 'memory');
  if (!existsSync(root)) return [];
  const out: LoadedMemoryFixture[] = [];
  for (const name of readdirSync(root).sort()) {
    const dir = join(root, name);
    if (!statSync(dir).isDirectory()) continue;
    const bytes: Record<string, Buffer> = {};
    for (const file of readdirSync(dir).sort()) {
      if (statSync(join(dir, file)).isFile()) bytes[file] = readFileSync(join(dir, file));
    }
    out.push({
      name,
      hash: memoryFixtureHash(bytes),
      files: Object.fromEntries(Object.entries(bytes).map(([k, v]) => [k, v.toString('utf8')])),
    });
  }
  return out;
}

/**
 * Reads tasks/<id>.json, validates it, and hashes it with its fixture tree. Only top-level
 * *.json files are tasks; tasks/_hashvector/task.json is test data and is not read here.
 */
export function loadTasks(tasksDir: string = defaultTasksDir()): LoadResult {
  const errors: string[] = [];
  const tasks: LoadedTask[] = [];
  const memoryFixtures = loadMemoryFixtures(tasksDir);
  const memoryNames = new Set(memoryFixtures.map((m) => m.name));
  const root = resolve(tasksDir);

  for (const file of readdirSync(tasksDir).filter((f) => f.endsWith('.json')).sort()) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(join(tasksDir, file), 'utf8'));
    } catch (e) {
      errors.push(`${file}: not valid JSON (${(e as Error).message})`);
      continue;
    }
    const floats = findNonIntegers(raw);
    if (floats.length) {
      errors.push(`${file}: non-integer numbers are not allowed in task JSON (${floats.join(', ')})`);
      continue;
    }
    const parsed = TaskFile.safeParse(raw);
    if (!parsed.success) {
      errors.push(...parsed.error.issues.map((i) => `${file}: ${i.path.join('.') || '(root)'}: ${i.message}`));
      continue;
    }
    const data = parsed.data;
    if (basename(file, '.json') !== data.id) {
      errors.push(`${file}: id "${data.id}" must match the file name`);
      continue;
    }
    if (data.memory_fixture !== null && !memoryNames.has(data.memory_fixture)) {
      errors.push(`${file}: memory_fixture "${data.memory_fixture}" not found under tasks/memory/`);
      continue;
    }
    let fixtureRoot: string | null = null;
    if (data.fixture_dir !== null) {
      fixtureRoot = resolve(root, data.fixture_dir);
      if (!fixtureRoot.startsWith(root + sep)) {
        errors.push(`${file}: fixture_dir "${data.fixture_dir}" escapes the tasks directory`);
        continue;
      }
      if (!existsSync(fixtureRoot) || !statSync(fixtureRoot).isDirectory()) {
        errors.push(`${file}: fixture_dir "${data.fixture_dir}" does not exist`);
        continue;
      }
    }
    const problems = lintTask(data, fixtureRoot);
    if (problems.length) {
      errors.push(...problems.map((p) => `${file}: ${p}`));
      continue;
    }
    tasks.push({ data, versionHash: taskHash(raw as Record<string, unknown>, readFixtureEntries(fixtureRoot)), file });
  }
  return { tasks, memoryFixtures, errors };
}
