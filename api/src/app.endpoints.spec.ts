import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { parseModelSeed } from './models/models.service';
import { createTestApp, FakeWorker, HERMES_VERSION } from './test-support/app';

describe('read endpoints and the boot-time seeds', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;

  beforeAll(async () => {
    ({ app } = await createTestApp(new FakeWorker()));
    http = request(app.getHttpServer());
  });
  afterAll(async () => {
    await app.close();
  });

  it('GET /health reaches the database', async () => {
    const res = await http.get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('GET /models lists the 2 seeded rows with the prices fetched from OpenRouter', async () => {
    const res = await http.get('/models');
    expect(res.status).toBe(200);
    const byId = Object.fromEntries(res.body.map((m: { id: string }) => [m.id, m]));
    expect(byId['model-a']).toMatchObject({
      slug: 'anthropic/claude-haiku-5.5',
      input_price_per_mtok: 0.1,
      output_price_per_mtok: 0.5,
      context_window: 1000000,
      api_key_env: 'OPENROUTER_API_KEY',
      base_url: 'https://openrouter.ai/api/v1',
    });
    expect(byId['model-b']).toMatchObject({
      slug: 'openai/gpt-oss-20b',
      input_price_per_mtok: 0.018,
      output_price_per_mtok: 0.09,
      context_window: 131072,
    });
  });

  it('GET /models never exposes a key value, only the variable name', async () => {
    const res = await http.get('/models');
    expect(JSON.stringify(res.body)).not.toMatch(/sk-or|Bearer/);
  });

  it('GET /harnesses lists what the worker manifest reported at boot', async () => {
    const res = await http.get('/harnesses');
    expect(res.status).toBe(200);
    expect(res.body[0]).toMatchObject({ id: 'hermes', version: HERMES_VERSION });
    expect(res.body[0].capabilities.memory_modes).toEqual(['off', 'seeded']);
  });

  it('GET /tasks lists the current version of each synced task', async () => {
    const res = await http.get('/tasks');
    const ids = res.body.map((t: { id: string }) => t.id);
    expect(ids).toEqual(expect.arrayContaining(['det-06-ini', 'mem-01-staging-db']));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('POST /tasks/sync is idempotent', async () => {
    const res = await http.post('/tasks/sync');
    expect(res.status).toBe(201);
    expect(res.body.errors).toEqual([]);
    expect(res.body.new_versions).toEqual([]);
    expect(res.body.tasks_on_disk).toBeGreaterThanOrEqual(2);
  });
});

describe('models seed validation', () => {
  const row = {
    id: 'model-x',
    display_name: 'x',
    slug: 'v/x',
    base_url: 'https://example.test/v1',
    api_key_env: 'KEY',
    input_price_per_mtok: 1,
    output_price_per_mtok: 2,
    context_window: 10,
    roles: ['candidate'],
  };

  it('accepts a well-formed row', () => {
    expect(parseModelSeed([row])).toHaveLength(1);
  });

  it.each([
    ['an id with capitals', { id: 'Model_X' }],
    ['a negative price', { input_price_per_mtok: -1 }],
    ['a zero context window', { context_window: 0 }],
    ['an unknown role', { roles: ['admin'] }],
    ['a base url that is not a url', { base_url: 'openrouter' }],
  ])('rejects %s', (_label, over) => {
    expect(() => parseModelSeed([{ ...row, ...over }])).toThrow();
  });
});
