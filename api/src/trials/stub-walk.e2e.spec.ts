/**
 * The gate-4 walk (cards/P1.md section 8) with the real worker and the real Hermes adapter, against
 * the scripted stub model server instead of OpenRouter. This is the "same trial runs against the
 * stub model server in the test suite" half of the P1 scope boundary.
 *
 * It needs a Python 3.14 environment with Hermes installed, so it is skipped unless E2E_PYTHON
 * points at that interpreter. The compose api image has no Python; the bare host run sets it:
 *   E2E_PYTHON=C:/hx/venv/Scripts/python.exe npm test -- stub-walk
 */
import { ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../app.module';

const PY = process.env.E2E_PYTHON;
const REPO = resolve(__dirname, '..', '..', '..');
const run = PY ? describe : describe.skip;

function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const s = createServer();
    s.once('error', fail);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => ok(port));
    });
  });
}

async function waitFor(url: string, ms: number): Promise<void> {
  const end = Date.now() + ms;
  for (;;) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > end) throw new Error(`${url} did not come up in ${ms} ms`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

function stubBaseUrl(proc: ChildProcess): Promise<string> {
  return new Promise((ok, fail) => {
    let buf = '';
    proc.stdout!.on('data', (d: Buffer) => {
      buf += d.toString();
      const line = buf.split(/\r?\n/).find((l) => l.startsWith('http://'));
      if (line) ok(line.trim());
    });
    proc.once('exit', (c) => fail(new Error(`stub exited with ${c}`)));
  });
}

run('gate-4 walk against the real worker and Hermes, with the stub model server', () => {
  let stub: ChildProcess;
  let worker: ChildProcess;
  let app: INestApplication;
  let http: ReturnType<typeof request>;

  const pyEnv = { ...process.env, PYTHONPATH: REPO, PYTHONUTF8: '1' };

  beforeAll(async () => {
    stub = spawn(PY!, ['-m', 'worker.tests.stub_model_server'], { cwd: REPO, env: pyEnv, stdio: ['ignore', 'pipe', 'inherit'] });
    const baseUrl = await stubBaseUrl(stub);

    const workerPort = await freePort();
    worker = spawn(PY!, ['-m', 'uvicorn', 'worker.server:app', '--port', String(workerPort), '--log-level', 'warning'], {
      cwd: REPO,
      env: {
        ...pyEnv,
        TASKS_DIR: join(REPO, 'tasks'),
        WORK_DIR: mkdtempSync(join(tmpdir(), 'walk-work-')),
        OPENROUTER_API_KEY: 'sk-stub-key-for-the-walk',
        KEEP_TRIAL_DIRS: '0',
      },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    await waitFor(`http://127.0.0.1:${workerPort}/health`, 60_000);

    const seed = join(mkdtempSync(join(tmpdir(), 'walk-models-')), 'models.json');
    const row = (id: string, scenario: string) => ({
      id,
      display_name: `stub ${scenario}`,
      slug: `stub/${scenario}`,
      base_url: baseUrl,
      api_key_env: 'OPENROUTER_API_KEY',
      input_price_per_mtok: 1,
      output_price_per_mtok: 2,
      context_window: 131072,
      roles: ['candidate'],
    });
    writeFileSync(seed, JSON.stringify([row('stub-det', 'shell_then_answer'), row('stub-mem', 'echo_memory')]));
    process.env.MODELS_SEED = seed;
    process.env.WORKER_URL = `http://127.0.0.1:${workerPort}`;
    process.env.TASKS_DIR = join(REPO, 'tasks');

    app = (await Test.createTestingModule({ imports: [AppModule] }).compile()).createNestApplication();
    await app.init();
    http = request(app.getHttpServer());
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    worker?.kill();
    stub?.kill();
  });

  const settings = (memory: object = { mode: 'off' }) => ({
    tools: ['shell', 'files'],
    memory,
    skills: { enabled: false, preload: [] },
    temperature: 0,
    max_steps: 15,
    max_output_tokens: 2048,
    timeout_seconds: 300,
    harness_options: {},
  });

  it('records the worker manifest at boot', async () => {
    const res = await http.get('/harnesses');
    expect(res.body.map((h: { id: string }) => h.id)).toContain('hermes');
    expect(res.body.find((h: { id: string }) => h.id === 'hermes').capabilities.tools).toEqual(['files', 'shell']); // not body[0]: other specs add harness rows
  });

  it('det-06-ini: POST /configs is 201 then 200, and the trial passes with a full trace', async () => {
    const body = { name: 'hermes memory off', harness_id: 'hermes', model_id: 'stub-det', settings: settings() };
    const created = await http.post('/configs').send(body);
    expect(created.status).toBe(201);
    expect(created.body.config_hash).toMatch(/^[0-9a-f]{64}$/);
    const again = await http.post('/configs').send(body);
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(created.body.id);

    const run1 = await http.post('/trials/adhoc').send({ config_id: created.body.id, task_id: 'det-06-ini' });
    expect(run1.status).toBe(201);
    expect(run1.body.trial).toMatchObject({ status: 'done', passed: true, exit_reason: 'completed' });

    const trace = (await http.get(`/trials/${run1.body.trial.id}/trace`)).body;
    const kinds = new Set(trace.events.map((e: { kind: string }) => e.kind));
    for (const k of ['message', 'tool_call', 'tool_result', 'api_call']) expect(kinds).toContain(k);
    expect(trace.final_response).toBe('FINAL: 8081');
    expect(trace.grader_results[0].passed).toBe(true);
    console.log(`walk: det-06-ini trial ${run1.body.trial.id}`);
  }, 180_000);

  it('mem-01-staging-db: seeded memory is in the system prompt and the trial passes; memory off does not', async () => {
    const seeded = await http
      .post('/configs')
      .send({ name: 'hermes memory seeded', harness_id: 'hermes', model_id: 'stub-mem', settings: settings({ mode: 'seeded', fixture: 'team-memory-v1' }) });
    expect(seeded.status).toBe(201);
    const run2 = await http.post('/trials/adhoc').send({ config_id: seeded.body.id, task_id: 'mem-01-staging-db' });
    expect(run2.body.trial).toMatchObject({ status: 'done', passed: true });
    const trace = (await http.get(`/trials/${run2.body.trial.id}/trace`)).body;
    expect(trace.events.some((e: { kind: string }) => e.kind === 'memory_read')).toBe(true);
    expect(trace.system_prompt).toContain('pg-stage-07');
    expect(trace.memory_initial['MEMORY.md']).toContain('pg-stage-07.internal');
    console.log(`walk: mem-01-staging-db trial ${run2.body.trial.id}`);

    const off = await http.post('/configs').send({ name: 'memory off, same model', harness_id: 'hermes', model_id: 'stub-mem', settings: settings() });
    const run3 = await http.post('/trials/adhoc').send({ config_id: off.body.id, task_id: 'mem-01-staging-db' });
    expect(run3.body.trial).toMatchObject({ status: 'done', passed: false });
    expect(run3.body.trace.events.some((e: { kind: string }) => e.kind === 'memory_read')).toBe(false);
    expect(run3.body.trace.system_prompt).not.toContain('pg-stage-07');
  }, 240_000);
});
