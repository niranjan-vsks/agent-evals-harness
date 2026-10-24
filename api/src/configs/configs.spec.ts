import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { memoryFixtureHash } from '../tasks/hash';
import { defaultTasksDir, loadMemoryFixtures } from '../tasks/load-tasks';
import { PrismaService } from '../prisma/prisma.service';
import { configBody, createTestApp, FakeWorker, HERMES_VERSION, MANIFEST } from '../test-support/app';
import { configHash, normalizeSettings } from './config-input';

describe('POST /configs', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let worker: FakeWorker;
  let http: ReturnType<typeof request>;

  beforeAll(async () => {
    worker = new FakeWorker();
    ({ app, prisma } = await createTestApp(worker));
    http = request(app.getHttpServer());
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => {
    worker.manifest = MANIFEST;
    worker.validateErrors = [];
    worker.validated = [];
  });

  // Each test uses its own max_steps so no test finds another's config by hash.
  let n = 100;
  const fresh = () => ({ max_steps: ++n });

  it('creates a config: 201 with a content hash, the worker-reported harness version and normalized settings', async () => {
    const res = await http.post('/configs').send(configBody({}, { ...fresh(), tools: ['shell', 'files', 'shell'] }));
    expect(res.status).toBe(201);
    expect(res.body.config_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(res.body).toMatchObject({ harness_id: 'hermes', harness_version: HERMES_VERSION, model_id: 'model-b', model_slug: 'openai/gpt-oss-20b' });
    expect(res.body.settings.tools).toEqual(['files', 'shell']);
    expect(res.body.settings.memory).toEqual({ mode: 'off', fixture: null, fixture_hash: null });
    expect(res.body.id).toMatch(/^[0-9A-Z]{26}$/);
  });

  it('is idempotent: the same body again is 200 with the same id', async () => {
    const body = configBody({}, fresh());
    const first = await http.post('/configs').send(body);
    const second = await http.post('/configs').send(body);
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.id).toBe(first.body.id);
    expect(second.body.config_hash).toBe(first.body.config_hash);
  });

  it('treats a different name, or the tools written in another order, as the same config (D-3)', async () => {
    const s = fresh();
    const first = await http.post('/configs').send(configBody({ name: 'one' }, { ...s, tools: ['shell', 'files'] }));
    const renamed = await http.post('/configs').send(configBody({ name: 'another label' }, { ...s, tools: ['files', 'shell'] }));
    expect(renamed.status).toBe(200);
    expect(renamed.body.id).toBe(first.body.id);
    expect(renamed.body.name).toBe('one');
  });

  it('treats providers_ignored as a set: another order or a repeat is the same config, and having it is a different one', async () => {
    const s = fresh();
    const first = await http.post('/configs').send(configBody({}, { ...s, harness_options: { providers_ignored: ['Groq', 'Darkbloom'] } }));
    const again = await http.post('/configs').send(configBody({}, { ...s, harness_options: { providers_ignored: ['Darkbloom', 'Groq', 'Darkbloom'] } }));
    const without = await http.post('/configs').send(configBody({}, s));
    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(first.body.id);
    expect(first.body.settings.harness_options).toEqual({ providers_ignored: ['Darkbloom', 'Groq'] });
    expect(without.status).toBe(201);
    expect(without.body.id).not.toBe(first.body.id);
  });

  it('makes a new config when any setting, the model or the harness version differs', async () => {
    const s = fresh();
    const base = await http.post('/configs').send(configBody({}, s));
    const warmer = await http.post('/configs').send(configBody({}, { ...s, temperature: 0.7 }));
    const otherModel = await http.post('/configs').send(configBody({ model_id: 'model-a' }, s));
    expect(warmer.status).toBe(201);
    expect(otherModel.status).toBe(201);
    expect(new Set([base.body.id, warmer.body.id, otherModel.body.id]).size).toBe(3);
    expect(new Set([base.body.config_hash, warmer.body.config_hash, otherModel.body.config_hash]).size).toBe(3);
  });

  it('hashes {harness_id, harness_version, model_slug, settings} exactly as DATA_MODEL 2.5 says', async () => {
    const res = await http.post('/configs').send(configBody({}, fresh()));
    expect(res.body.config_hash).toBe(
      configHash({ harness_id: 'hermes', harness_version: HERMES_VERSION, model_slug: 'openai/gpt-oss-20b', settings: res.body.settings }),
    );
  });

  it('resolves the memory fixture hash into the settings and the hash (D-5)', async () => {
    const real = loadMemoryFixtures(defaultTasksDir()).find((f) => f.name === 'team-memory-v1')!;
    const s = fresh();
    const res = await http.post('/configs').send(configBody({}, { ...s, memory: { mode: 'seeded', fixture: 'team-memory-v1' } }));
    expect(res.status).toBe(201);
    expect(res.body.settings.memory).toEqual({ mode: 'seeded', fixture: 'team-memory-v1', fixture_hash: real.hash });
    expect(real.hash).toBe(memoryFixtureHash(real.files));

    // Editing the fixture file produces a different config, never a silent change to this one.
    await prisma.memoryFixture.create({
      data: { name: 'team-memory-v1', hash: 'e'.repeat(64), files: { 'MEMORY.md': 'edited' }, syncedAt: new Date(Date.now() + 60_000) },
    });
    const edited = await http.post('/configs').send(configBody({}, { ...s, memory: { mode: 'seeded', fixture: 'team-memory-v1' } }));
    expect(edited.status).toBe(201);
    expect(edited.body.id).not.toBe(res.body.id);
    expect(edited.body.settings.memory.fixture_hash).toBe('e'.repeat(64));
    // The first config still points at the content it was created with.
    expect((await http.get(`/configs/${res.body.id}`)).body.settings.memory.fixture_hash).toBe(real.hash);
    await prisma.memoryFixture.delete({ where: { name_hash: { name: 'team-memory-v1', hash: 'e'.repeat(64) } } });
  });

  it('refuses a config the adapter cannot honor, with its reasons, and stores nothing (D-4)', async () => {
    const before = await prisma.config.count();
    worker.validateErrors = ['harness_options.turbo is not supported by hermes'];
    const res = await http.post('/configs').send(configBody({}, { ...fresh(), harness_options: { turbo: true } }));
    expect(res.status).toBe(400);
    expect(res.body.reasons).toEqual(['harness_options.turbo is not supported by hermes']);
    expect(await prisma.config.count()).toBe(before);
  });

  it('sends the worker the resolved settings to validate', async () => {
    await http.post('/configs').send(configBody({}, { ...fresh(), memory: { mode: 'seeded', fixture: 'team-memory-v1' } }));
    expect(worker.validated).toHaveLength(1);
    expect(worker.validated[0].memory.fixture_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects malformed bodies with 400', async () => {
    expect((await http.post('/configs').send({})).status).toBe(400);
    expect((await http.post('/configs').send(configBody({ surprise: 1 }))).status).toBe(400);
    expect((await http.post('/configs').send(configBody({}, { max_steps: 0 }))).status).toBe(400);
    expect((await http.post('/configs').send(configBody({}, { tools: ['browser'] }))).status).toBe(400);
    expect((await http.post('/configs').send(configBody({}, { memory: { mode: 'persistent' } }))).status).toBe(400);
  });

  it('refuses an unknown model, an unknown harness and an unsynced fixture with 400', async () => {
    expect((await http.post('/configs').send(configBody({ model_id: 'nope' }, fresh()))).status).toBe(400);
    expect((await http.post('/configs').send(configBody({ harness_id: 'nope' }, fresh()))).status).toBe(400);
    const res = await http.post('/configs').send(configBody({}, { ...fresh(), memory: { mode: 'seeded', fixture: 'absent' } }));
    expect(res.status).toBe(400);
    expect(res.body.reasons[0]).toContain('absent');
  });

  it('answers 503 when the worker cannot be reached', async () => {
    worker.manifest = new Error('connect ECONNREFUSED');
    const res = await http.post('/configs').send(configBody({}, fresh()));
    expect(res.status).toBe(503);
  });

  it('creates exactly 1 row when identical requests race', async () => {
    const body = configBody({}, fresh());
    const results = await Promise.all([1, 2, 3, 4].map(() => http.post('/configs').send(body)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
    expect(await prisma.config.count({ where: { configHash: results[0].body.config_hash } })).toBe(1);
  });
});

describe('configs are immutable and listed', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let id: string;

  beforeAll(async () => {
    ({ app } = await createTestApp(new FakeWorker()));
    http = request(app.getHttpServer());
    id = (await http.post('/configs').send(configBody({}, { max_steps: 9001 }))).body.id;
  });
  afterAll(async () => {
    await app.close();
  });

  it('answers 405 to PUT, PATCH and DELETE (D-3)', async () => {
    for (const m of ['put', 'patch', 'delete'] as const) {
      const res = await http[m](`/configs/${id}`).send({ name: 'x' });
      expect(res.status).toBe(405);
    }
    expect((await http.put('/configs').send({})).status).toBe(405);
    expect((await http.get(`/configs/${id}`)).body.name).toBe('hermes memory off');
  });

  it('lists configs and gets one by id; unknown id is 404', async () => {
    const list = await http.get('/configs');
    expect(list.status).toBe(200);
    expect(list.body.map((c: { id: string }) => c.id)).toContain(id);
    expect((await http.get('/configs/NOPE')).status).toBe(404);
  });
});

describe('normalizeSettings', () => {
  it('always yields the full memory block and de-duplicated, sorted tools', () => {
    const parsed = {
      tools: ['shell', 'files', 'shell'] as ('shell' | 'files')[],
      memory: { mode: 'off' as const },
      skills: { enabled: false, preload: [] },
      temperature: 0,
      max_steps: 1,
      max_output_tokens: 1,
      timeout_seconds: 1,
      harness_options: {},
    };
    const out = normalizeSettings(parsed, null);
    expect(out.tools).toEqual(['files', 'shell']);
    expect(out.memory).toEqual({ mode: 'off', fixture: null, fixture_hash: null });
  });
});

