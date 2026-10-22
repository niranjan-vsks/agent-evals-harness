import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaService } from '../prisma/prisma.service';
import { defaultTasksDir } from './load-tasks';
import { TasksService } from './tasks.service';

function task(id: string, over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id,
    category: 'neutral_deterministic',
    prompt: 'first prompt',
    fixture_dir: null,
    memory_fixture: null,
    graders: [{ type: 'exact_match', expected: 'x' }],
    discriminates: [],
    tags: [],
    ...over,
  });
}

describe('task sync', () => {
  let prisma: PrismaService;
  let service: TasksService;
  let dir: string;
  let id: string;
  let n = 0;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    service = new TasksService(prisma);
  });
  afterAll(async () => {
    await prisma.onModuleDestroy();
  });
  beforeEach(() => {
    id = `syn-01-${Date.now().toString(36)}-${n++}`; // unique per test: rows persist for the whole run
    dir = mkdtempSync(join(tmpdir(), 'sync-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const rows = () => prisma.task.findMany({ where: { id }, orderBy: { syncedAt: 'asc' } });

  it('inserts a task as the current version and is idempotent', async () => {
    writeFileSync(join(dir, `${id}.json`), task(id));
    const first = await service.sync(dir);
    expect(first.new_versions).toHaveLength(1);
    expect(first.errors).toEqual([]);
    const again = await service.sync(dir);
    expect(again.new_versions).toEqual([]);
    const found = await rows();
    expect(found).toHaveLength(1);
    expect(found[0].isCurrent).toBe(true);
    expect(found[0].versionHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('keeps the old version and moves is_current when the task changes (D-2, D-6)', async () => {
    writeFileSync(join(dir, `${id}.json`), task(id));
    await service.sync(dir);
    const [v1] = await rows();
    writeFileSync(join(dir, `${id}.json`), task(id, { prompt: 'second prompt' }));
    const result = await service.sync(dir);
    expect(result.new_versions).toHaveLength(1);
    const found = await rows();
    expect(found).toHaveLength(2);
    expect(found.filter((r) => r.isCurrent)).toHaveLength(1);
    expect(found.find((r) => r.versionHash === v1.versionHash)?.isCurrent).toBe(false);
    expect(found.find((r) => r.isCurrent)?.prompt).toBe('second prompt');
    // Going back to the first text makes the first version current again, without a third row.
    writeFileSync(join(dir, `${id}.json`), task(id));
    await service.sync(dir);
    const back = await rows();
    expect(back).toHaveLength(2);
    expect(back.find((r) => r.isCurrent)?.versionHash).toBe(v1.versionHash);
  });

  it('retires a task that is no longer on disk without deleting it', async () => {
    writeFileSync(join(dir, `${id}.json`), task(id));
    await service.sync(dir);
    writeFileSync(join(dir, 'other-01-x.json'), task('other-01-x'));
    rmSync(join(dir, `${id}.json`));
    const result = await service.sync(dir);
    expect(result.retired).toContain(id);
    const found = await rows();
    expect(found).toHaveLength(1);
    expect(found[0].isCurrent).toBe(false);
  });

  it('does not stop on an invalid file: valid tasks sync and the error is reported', async () => {
    writeFileSync(join(dir, `${id}.json`), task(id));
    writeFileSync(join(dir, 'bad-01-x.json'), '{nope');
    const result = await service.sync(dir);
    expect(result.errors).toHaveLength(1);
    expect((await rows()).filter((r) => r.isCurrent)).toHaveLength(1);
  });

  it('serializes concurrent syncs so the one-current-version index is never violated', async () => {
    writeFileSync(join(dir, `${id}.json`), task(id));
    await Promise.all([service.sync(dir), service.sync(dir), service.sync(dir)]);
    expect(await rows()).toHaveLength(1);
  });

  it('syncs memory fixtures by content hash', async () => {
    mkdirSync(join(dir, 'memory', 'fx-test'), { recursive: true });
    writeFileSync(join(dir, 'memory', 'fx-test', 'MEMORY.md'), 'one');
    await service.sync(dir);
    writeFileSync(join(dir, 'memory', 'fx-test', 'MEMORY.md'), 'two');
    await service.sync(dir);
    const found = await prisma.memoryFixture.findMany({ where: { name: 'fx-test' } });
    expect(found).toHaveLength(2);
    expect(new Set(found.map((f) => f.hash)).size).toBe(2);
    expect(found.map((f) => (f.files as Record<string, string>)['MEMORY.md']).sort()).toEqual(['one', 'two']);
  });

  it('syncs the real tasks directory', async () => {
    const result = await service.sync(defaultTasksDir());
    expect(result.errors).toEqual([]);
    const current = await service.listCurrent();
    const ids = current.map((t) => t.id);
    expect(ids).toContain('det-06-ini');
    expect(ids).toContain('mem-01-staging-db');
    const mem = current.find((t) => t.id === 'mem-01-staging-db');
    expect(mem?.memory_fixture).toBe('team-memory-v1');
    expect(mem?.category).toBe('memory_dependent');
  });
});
