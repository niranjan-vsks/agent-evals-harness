import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { Fixtures } from '../../test/helpers';
import { PrismaService } from '../prisma/prisma.service';
import { doneResult } from '../test-support/app';
import { erroredResult, FailureTask, MAX_TRACE_BYTES } from '../trials/ingest';
import { decideRetry } from './retry-policy';
import { TrialResult, TrialSpec } from '../worker-client/types';
import { WorkerClient, WorkerUnavailableError } from '../worker-client/worker-client';
import { buildSpec, ClaimedTrial, runOnWorker, SpecBuildError, workerHttpStatus } from './dispatch';

const PRICE = { input_price_per_mtok: 1, output_price_per_mtok: 2 };
const TASK: FailureTask = { graderCount: 1, taskCategory: 'neutral_deterministic', taskFixtureDir: null, memoryMode: 'off' };

function specOf(over: Partial<TrialSpec> = {}): TrialSpec {
  return {
    trial_id: 'T1',
    attempt: 1,
    seed: 1,
    harness: 'h',
    model: { id: 'm', slug: 's', base_url: 'http://x', api_key_env: 'K', input_price_per_mtok: 1, output_price_per_mtok: 2, cached_input_price_per_mtok: 0.5, context_window: 1000 },
    settings: {
      tools: [],
      memory: { mode: 'off', fixture: null, fixture_hash: null },
      skills: { enabled: false, preload: [] },
      temperature: 0,
      max_steps: 1,
      max_output_tokens: 1,
      timeout_seconds: 5,
      harness_options: {},
    },
    task: { id: 'tst-01-x', version_hash: 'h', prompt: 'p', fixture_dir: null, memory_fixture: null, graders: [{ type: 'exact_match' }] },
    memory_seed: null,
    ...over,
  };
}

const workerThrowing = (e: unknown) => ({ runTrial: async () => Promise.reject(e) });
const workerReturning = (r: TrialResult) => ({ runTrial: async () => r });

describe('workerHttpStatus', () => {
  it('reads the status out of the WorkerClient message', () => {
    expect(workerHttpStatus(new WorkerUnavailableError('worker /trials/run answered HTTP 429: {"detail":"worker at capacity"}'))).toBe(429);
    expect(workerHttpStatus(new WorkerUnavailableError('worker /trials/run answered HTTP 500: boom'))).toBe(500);
  });

  it('is null for anything that is not a non-2xx answer', () => {
    expect(workerHttpStatus(new WorkerUnavailableError('worker /trials/run: fetch failed'))).toBeNull();
    expect(workerHttpStatus(new Error('worker /trials/run answered HTTP 429: x'))).toBeNull();
    expect(workerHttpStatus('answered HTTP 429')).toBeNull();
    expect(workerHttpStatus(null)).toBeNull();
  });

  describe('format pinned against the real WorkerClient', () => {
    let server: Server;
    let status = 429;
    const saved = process.env.WORKER_URL;
    beforeAll(async () => {
      server = createServer((_req, res) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ detail: 'worker at capacity' }));
      });
      await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
      process.env.WORKER_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    afterAll(async () => {
      if (saved === undefined) delete process.env.WORKER_URL;
      else process.env.WORKER_URL = saved;
      server.closeAllConnections();
      await new Promise<void>((ok) => server.close(() => ok()));
    });

    it.each([429, 500, 503])('HTTP %i from the worker is parsed back by workerHttpStatus', async (code) => {
      status = code;
      const err = await new WorkerClient().runTrial(specOf()).catch((e) => e);
      expect(err).toBeInstanceOf(WorkerUnavailableError);
      expect(workerHttpStatus(err)).toBe(code);
    });
  });
});

describe('runOnWorker failure mapping', () => {
  it('HTTP 429 is backpressure', async () => {
    const e = new WorkerUnavailableError('worker /trials/run answered HTTP 429: {"detail":"worker at capacity"}');
    const o = await runOnWorker(workerThrowing(e), specOf(), PRICE, TASK);
    expect(o.ingested).toMatchObject({ status: 'errored', errorClass: 'backpressure', errorMessage: e.message });
    expect(o.maxAttempts).toBeUndefined();
  });

  it('any other HTTP error or a refused connection is worker_crash with the client message', async () => {
    for (const msg of ['worker /trials/run answered HTTP 500: boom', 'worker /trials/run: fetch failed']) {
      const o = await runOnWorker(workerThrowing(new WorkerUnavailableError(msg)), specOf(), PRICE, TASK);
      expect(o.ingested).toMatchObject({ status: 'errored', errorClass: 'worker_crash', errorMessage: msg });
    }
  });

  it('a non-client error is worker_crash "worker call failed"', async () => {
    const o = await runOnWorker(workerThrowing(new Error('boom')), specOf(), PRICE, TASK);
    expect(o.ingested).toMatchObject({ errorClass: 'worker_crash', errorMessage: 'worker call failed: boom' });
  });

  it('an errored TrialResult keeps its own error_class', async () => {
    const r: TrialResult = { ...erroredResult('rate_limited', 'provider said 429'), trial_id: 'T1', attempt: 1 };
    const o = await runOnWorker(workerReturning(r), specOf(), PRICE, TASK);
    expect(o.ingested).toMatchObject({ status: 'errored', errorClass: 'rate_limited', errorMessage: 'provider said 429' });
  });

  it('a done result is ingested with the cost from the price given', async () => {
    const o = await runOnWorker(workerReturning(doneResult(specOf())), specOf(), { input_price_per_mtok: 3, output_price_per_mtok: 4 }, TASK);
    expect(o.ingested.status).toBe('done');
    expect(Number(o.ingested.costUsd)).toBeCloseTo((3000 * 3 + 40 * 4) / 1e6, 9);
  });

  it('a result the API cannot store (D-14) is worker_crash "worker result rejected", with the trace kept as the partial trace', async () => {
    const bad = doneResult(specOf(), { passed: true });
    bad.grader_results[0].passed = false;
    const o = await runOnWorker(workerReturning(bad), specOf(), PRICE, TASK);
    expect(o.ingested.status).toBe('errored');
    expect(o.ingested.errorClass).toBe('worker_crash');
    expect(o.ingested.errorMessage).toMatch(/^worker result rejected: D-14/);
    expect(o.ingested.partialTrace).toHaveLength(7);
    expect(o.maxAttempts).toBeUndefined();
  });

  it('a result whose grader count differs from that of the task is worker_crash "worker result rejected", and worker_crash is retried', async () => {
    const o = await runOnWorker(workerReturning(doneResult(specOf())), specOf(), PRICE, { ...TASK, graderCount: 2 });
    expect(o.ingested).toMatchObject({ status: 'errored', errorClass: 'worker_crash', passed: null });
    expect(o.ingested.errorMessage).toMatch(/^worker result rejected: the task has 2 graders but the result carries 1/);
    expect(o.maxAttempts).toBeUndefined();
    expect(decideRetry('worker_crash', 1, { maxAttempts: o.maxAttempts }).retry).toBe(true);
  });

  it('an oversized trace is worker_crash that may be retried once (maxAttempts 2)', async () => {
    const big = doneResult(specOf());
    big.trace!.events = [{ seq: 0, t_ms: 0, kind: 'message', content: 'x'.repeat(MAX_TRACE_BYTES + 10) }];
    const o = await runOnWorker(workerReturning(big), specOf(), PRICE, TASK);
    expect(o.ingested).toMatchObject({ status: 'errored', errorClass: 'worker_crash' });
    expect(o.ingested.errorMessage).toMatch(/^worker result rejected: trace is larger than/);
    expect(o.maxAttempts).toBe(2);
  });
});

describe('buildSpec', () => {
  let prisma: PrismaService;
  let fx: Fixtures;
  let base: Awaited<ReturnType<Fixtures['base']>>;
  const savedJudge = process.env.JUDGE_MODEL_ID;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();
    fx = new Fixtures(prisma);
    base = await fx.base();
  });
  afterAll(async () => {
    if (savedJudge === undefined) delete process.env.JUDGE_MODEL_ID;
    else process.env.JUDGE_MODEL_ID = savedJudge;
    await fx.cleanup();
    await prisma.$disconnect();
  });

  async function claimed(configId: string, taskId: string, over: Partial<ClaimedTrial> = {}): Promise<ClaimedTrial> {
    const t = await prisma.task.findFirstOrThrow({ where: { id: taskId, isCurrent: true } });
    return {
      trialId: 'T-build',
      experimentId: 'E',
      configId,
      taskId,
      taskVersionHash: t.versionHash,
      seed: 42,
      attemptNo: 3,
      attemptCount: 2,
      price: { input_price_per_mtok: 7, output_price_per_mtok: 8, cached_input_price_per_mtok: 3 },
      modelSlug: base.modelSlug,
      ...over,
    };
  }

  it('builds the spec adhoc.ts built: attempt = attempt_no, claimed price, no memory seed, no judge', async () => {
    const cfg = await fx.config(base, 'plain', { max_steps: 77 });
    await fx.tasks(['scd-01-plain']);
    const spec = await buildSpec(prisma, await claimed(cfg, 'scd-01-plain'));
    expect(spec).toMatchObject({
      trial_id: 'T-build',
      attempt: 3,
      seed: 42,
      harness: base.harnessId,
      model: { id: base.modelId, slug: base.modelSlug, input_price_per_mtok: 7, output_price_per_mtok: 8, cached_input_price_per_mtok: 3, context_window: 1000 },
      settings: { max_steps: 77 },
      task: { id: 'scd-01-plain', prompt: 'prompt of scd-01-plain', fixture_dir: null, memory_fixture: null },
      memory_seed: null,
    });
    expect('judge_model' in spec).toBe(false);
  });

  it('a claimed price without the cached field (dispatched before 0004) gives the worker the input price as the cached price', async () => {
    const cfg = await fx.config(base, 'legacy-price');
    const spec = await buildSpec(prisma, await claimed(cfg, 'scd-01-plain', { price: { input_price_per_mtok: 7, output_price_per_mtok: 8 } }));
    expect(spec.model.cached_input_price_per_mtok).toBe(7);
  });

  it('seeds memory from the stored fixture, MEMORY.md and USER.md only', async () => {
    await prisma.memoryFixture.create({ data: { name: 'scd-mem', hash: 'h1', files: { 'MEMORY.md': 'm', 'USER.md': 'u', 'notes.txt': 'n' } } });
    fx.memoryFixtures.push({ name: 'scd-mem', hash: 'h1' });
    const cfg = await fx.config(base, 'seeded', { memory: { mode: 'seeded', fixture: 'scd-mem', fixture_hash: 'h1' } });
    const spec = await buildSpec(prisma, await claimed(cfg, 'scd-01-plain'));
    expect(spec.memory_seed).toEqual({ 'MEMORY.md': 'm', 'USER.md': 'u' });
  });

  it('a memory fixture that is gone is a SpecBuildError (D-5)', async () => {
    const cfg = await fx.config(base, 'gone', { memory: { mode: 'seeded', fixture: 'scd-gone', fixture_hash: 'zz' } });
    await expect(buildSpec(prisma, await claimed(cfg, 'scd-01-plain'))).rejects.toThrow(SpecBuildError);
    await expect(buildSpec(prisma, await claimed(cfg, 'scd-01-plain'))).rejects.toThrow(/scd-gone@zz is no longer stored/);
  });

  it('a task version that is gone is a SpecBuildError', async () => {
    const cfg = await fx.config(base, 'x');
    await expect(buildSpec(prisma, await claimed(cfg, 'scd-01-plain', { taskVersionHash: 'not-stored' }))).rejects.toThrow(SpecBuildError);
  });

  it('a judged task carries the configured judge model; with no judge configured it is a SpecBuildError', async () => {
    const judgeId = `sch-j-${base.modelId.slice(6)}`;
    await prisma.model.create({
      data: {
        id: judgeId,
        displayName: 'j',
        slug: `sch/${judgeId}`,
        baseUrl: 'http://j',
        apiKeyEnv: 'JK',
        inputPricePerMtok: 0.5,
        outputPricePerMtok: 1.5,
        contextWindow: 5000,
        roles: ['judge'],
      },
    });
    fx.modelIds.push(judgeId);
    await fx.tasks(['scd-02-judged'], [{ type: 'llm_judge', rubric: 'r' }]);
    const cfg = await fx.config(base, 'judged');

    process.env.JUDGE_MODEL_ID = judgeId;
    const spec = await buildSpec(prisma, await claimed(cfg, 'scd-02-judged'));
    expect(spec.judge_model).toMatchObject({ id: judgeId, base_url: 'http://j', api_key_env: 'JK', input_price_per_mtok: 0.5, context_window: 5000 });

    process.env.JUDGE_MODEL_ID = 'no-such-judge';
    await expect(buildSpec(prisma, await claimed(cfg, 'scd-02-judged'))).rejects.toThrow(SpecBuildError);
    process.env.JUDGE_MODEL_ID = base.modelId; // exists but is not a judge
    await expect(buildSpec(prisma, await claimed(cfg, 'scd-02-judged'))).rejects.toThrow(/judge role/);
  });
});
