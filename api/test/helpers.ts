/**
 * Fixtures for the scheduler specs. Rows are inserted straight through Prisma (no ExperimentsService), and every
 * id is tracked so `cleanup` can remove exactly what a spec created: the specs share one database.
 */
import { ulid } from '../src/common/ulid';
import { Prisma, PrismaClient } from '../src/generated/prisma/client';
import { trialSeed } from '../src/trials/seed';
import { TrialSpec } from '../src/worker-client/types';

export const PLACEHOLDER_PRICE = { input_price_per_mtok: 999, output_price_per_mtok: 999, cached_input_price_per_mtok: 999 };

export function settingsJson(over: Record<string, unknown> = {}) {
  return {
    tools: ['shell', 'files'],
    memory: { mode: 'off', fixture: null, fixture_hash: null },
    skills: { enabled: false, preload: [] },
    temperature: 0,
    max_steps: 15,
    max_output_tokens: 2048,
    timeout_seconds: 300,
    harness_options: {},
    ...over,
  };
}

export class Fixtures {
  experimentIds: string[] = [];
  configIds: string[] = [];
  taskIds: string[] = [];
  modelIds: string[] = [];
  harnessIds: string[] = [];
  memoryFixtures: { name: string; hash: string }[] = [];

  constructor(readonly prisma: PrismaClient) {}

  /** A candidate model (prices 1 and 2) and a harness row; every config of a spec shares them. */
  async base(): Promise<{ modelId: string; modelSlug: string; harnessId: string; harnessVersion: string }> {
    const tag = ulid().toLowerCase();
    const modelId = `sch-m-${tag}`;
    const modelSlug = `sch/${tag}`;
    const harnessId = `sch_h_${tag}`;
    await this.prisma.model.create({
      data: {
        id: modelId,
        displayName: 'scheduler test model',
        slug: modelSlug,
        baseUrl: 'http://x',
        apiKeyEnv: 'KEY',
        inputPricePerMtok: 1,
        outputPricePerMtok: 2,
        cachedInputPricePerMtok: 0.5,
        contextWindow: 1000,
        roles: ['candidate'],
      },
    });
    await this.prisma.harness.create({ data: { id: harnessId, version: 'v1', capabilities: {} } });
    this.modelIds.push(modelId);
    this.harnessIds.push(harnessId);
    return { modelId, modelSlug, harnessId, harnessVersion: 'v1' };
  }

  async config(
    b: { modelId: string; modelSlug: string; harnessId: string; harnessVersion: string },
    name: string,
    settings: Record<string, unknown> = {},
  ): Promise<string> {
    const id = ulid();
    await this.prisma.config.create({
      data: {
        id,
        name,
        harnessId: b.harnessId,
        harnessVersion: b.harnessVersion,
        modelId: b.modelId,
        modelSlug: b.modelSlug,
        settings: settingsJson(settings),
        configHash: `sch-${id}`,
      },
    });
    this.configIds.push(id);
    return id;
  }

  /** Current task rows whose id ends in the scripted outcome suffix, e.g. `sch-01-ok`. Returns id -> version hash. */
  async tasks(ids: string[], graders: unknown[] = [{ type: 'exact_match', expected: '8081' }]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const id of ids) {
      const versionHash = `hash-${id}`;
      await this.prisma.task.create({
        data: {
          id,
          versionHash,
          category: 'neutral_deterministic',
          prompt: `prompt of ${id}`,
          graders: graders as never,
          discriminates: ['model'],
          tags: [],
          isCurrent: true,
        },
      });
      this.taskIds.push(id);
      out.set(id, versionHash);
    }
    return out;
  }

  /**
   * A started experiment (status queued unless told otherwise) with every (config, task, index) trial pending,
   * exactly what ExperimentsService.start will produce.
   */
  async experiment(opts: {
    configIds: string[];
    taskIds: string[];
    nTrials?: number;
    status?: 'draft' | 'queued' | 'running';
    pauseReason?: string | null;
    seed?: number;
  }): Promise<{ id: string; trialIds: string[] }> {
    const id = ulid();
    const n = opts.nTrials ?? 1;
    const seed = opts.seed ?? 1;
    await this.prisma.experiment.create({
      data: {
        id,
        name: `sch-${id}`,
        status: opts.status ?? 'queued',
        nTrials: n,
        seed,
        phase: 'full',
        workerManifest: {},
        pauseReason: opts.pauseReason ?? null,
      },
    });
    this.experimentIds.push(id);
    for (const [position, configId] of opts.configIds.entries()) {
      await this.prisma.experimentConfig.create({ data: { experimentId: id, configId, position } });
    }
    const hashes = new Map<string, string>();
    for (const taskId of opts.taskIds) {
      const t = await this.prisma.task.findFirstOrThrow({ where: { id: taskId, isCurrent: true } });
      hashes.set(taskId, t.versionHash);
      await this.prisma.experimentTask.create({ data: { experimentId: id, taskId, taskVersionHash: t.versionHash } });
    }
    const trialIds: string[] = [];
    const rows = [];
    for (let index = 0; index < n; index++) {
      for (const taskId of opts.taskIds) {
        for (const configId of opts.configIds) {
          const tid = ulid();
          trialIds.push(tid);
          rows.push({
            id: tid,
            experimentId: id,
            configId,
            taskId,
            taskVersionHash: hashes.get(taskId)!,
            trialIndex: index,
            seed: trialSeed(seed, configId, taskId, index),
            status: 'pending' as const,
            priceSnapshot: PLACEHOLDER_PRICE,
          });
        }
      }
    }
    await this.prisma.trial.createMany({ data: rows });
    return { id, trialIds };
  }

  /** The scheduler claims any pending trial of any queued or running experiment, so a spec parks everything else first. */
  /** Tracks an experiment that was not created by `experiment()` (say, through ExperimentsService) so cleanup() removes it. */
  track(experimentId: string): void {
    if (!this.experimentIds.includes(experimentId)) this.experimentIds.push(experimentId);
  }

  async isolate(): Promise<number> {
    await this.prisma.$executeRaw`
      UPDATE experiment SET pause_reason = 'test isolation'
      WHERE pause_reason IS NULL AND status IN ('queued'::experiment_status, 'running'::experiment_status)`;
    return this.prisma.trial.count({ where: { status: 'running' } });
  }

  async cleanup(): Promise<void> {
    const p = this.prisma;
    await p.$executeRaw`UPDATE experiment SET pause_reason = NULL WHERE pause_reason = 'test isolation'`;
    const mine = await p.trial.findMany({ where: { experimentId: { in: this.experimentIds } }, select: { id: true } });
    const trials = { trialId: { in: mine.map((t) => t.id) } };
    await p.graderResult.deleteMany({ where: trials });
    await p.trace.deleteMany({ where: trials });
    await p.trialAttempt.deleteMany({ where: trials });
    await p.trial.deleteMany({ where: { experimentId: { in: this.experimentIds } } });
    await p.experimentTask.deleteMany({ where: { experimentId: { in: this.experimentIds } } });
    await p.experimentConfig.deleteMany({ where: { experimentId: { in: this.experimentIds } } });
    await p.experiment.deleteMany({ where: { id: { in: this.experimentIds } } });
    await p.config.deleteMany({ where: { id: { in: this.configIds } } });
    await p.task.deleteMany({ where: { id: { in: this.taskIds } } });
    for (const f of this.memoryFixtures) await p.memoryFixture.deleteMany({ where: { name: f.name, hash: f.hash } });
    await p.harness.deleteMany({ where: { id: { in: this.harnessIds } } });
    await p.model.deleteMany({ where: { id: { in: this.modelIds } } });
  }
}

export async function waitFor(cond: () => Promise<boolean> | boolean, ms = 5000, what = 'condition'): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

export const sleep = (ms: number) => new Promise<void>((ok) => setTimeout(ok, ms));

/**
 * Holds the row lock of an experiment in a separate transaction while `body` runs, then commits. A writer that follows the
 * lock order (experiment row first) has to wait for it without having touched any trial row; `trialRowIsFree` checks that.
 */
export async function withExperimentLock<T>(
  prisma: PrismaClient,
  experimentId: string,
  body: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM experiment WHERE id = ${experimentId} FOR UPDATE`;
      return body(tx);
    },
    { timeout: 30_000, maxWait: 10_000 },
  );
}

/** True when no other transaction holds a lock on the trial row: a FOR UPDATE NOWAIT probe inside `tx`, which fails fast if one does. */
export async function trialRowIsFree(tx: Prisma.TransactionClient, trialId: string): Promise<boolean> {
  try {
    await tx.$queryRaw`SELECT id FROM trial WHERE id = ${trialId} FOR UPDATE NOWAIT`;
    return true;
  } catch {
    return false;
  }
}

/** A TrialSpec just rich enough for doneResult() and the fake worker. */
export function miniSpec(over: Partial<TrialSpec> = {}): TrialSpec {
  return {
    trial_id: 'T1',
    attempt: 1,
    seed: 1,
    harness: 'h',
    model: { id: 'm', slug: 's', base_url: 'http://x', api_key_env: 'K', input_price_per_mtok: 1, output_price_per_mtok: 2, cached_input_price_per_mtok: 0.5, context_window: 1000 },
    settings: settingsJson() as TrialSpec['settings'],
    task: { id: 'tst-01-x', version_hash: 'h', prompt: 'p', fixture_dir: null, memory_fixture: null, graders: [{ type: 'exact_match' }] },
    memory_seed: null,
    ...over,
  };
}
