/**
 * Spec building and result routing for one claimed trial (brief "Scheduler"). No transitions are written here:
 * buildSpec reads, runOnWorker calls the worker and maps every outcome to an IngestedTrial, and settle.ts persists it.
 */
import { HttpException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { resolveJudgeModel } from '../judge/judge-model';
import { erroredResult, FailureTask, IngestedTrial, ingest, IngestError, PriceSnapshot } from '../trials/ingest';
import { SettingsJson, TrialResult, TrialSpec } from '../worker-client/types';
import { WorkerClient, WorkerUnavailableError } from '../worker-client/worker-client';

/** What a successful claim hands to the dispatch. */
export interface ClaimedTrial {
  trialId: string;
  experimentId: string;
  configId: string;
  taskId: string;
  taskVersionHash: string;
  seed: number;
  /** The attempt row written by the claim; also TrialSpec.attempt. */
  attemptNo: number;
  /** attempt_count after the claim. */
  attemptCount: number;
  /** Prices read at claim time (D-7). */
  price: PriceSnapshot;
  modelSlug: string;
}

/** The spec cannot be built from stored data: not a transient fault, so the trial ends config_invalid with no retry. */
export class SpecBuildError extends Error {}

/**
 * HTTP status of a non-2xx worker answer. WorkerClient does not expose it, so this parses the message
 * `worker <path> answered HTTP <status>: <body>`; dispatch.spec.ts pins that format against the real client.
 */
export function workerHttpStatus(err: unknown): number | null {
  if (!(err instanceof WorkerUnavailableError)) return null;
  const m = /answered HTTP (\d{3})\b/.exec(err.message);
  return m ? Number(m[1]) : null;
}

export async function buildSpec(prisma: PrismaService, c: ClaimedTrial): Promise<TrialSpec> {
  return (await buildSpecAndContext(prisma, c)).spec;
}

/** The spec for the worker, and what the failure rules need that the worker's result does not carry (task category, fixture, memory mode). */
export async function buildSpecAndContext(prisma: PrismaService, c: ClaimedTrial): Promise<{ spec: TrialSpec; failureTask: FailureTask }> {
  const config = await prisma.config.findUniqueOrThrow({ where: { id: c.configId }, include: { model: true } });
  const task = await prisma.task.findUnique({ where: { id_versionHash: { id: c.taskId, versionHash: c.taskVersionHash } } });
  if (!task) throw new SpecBuildError(`task ${c.taskId}@${c.taskVersionHash} is no longer stored`);

  const settings = config.settings as unknown as SettingsJson;
  let memorySeed: Record<string, string> | null = null;
  if (settings.memory?.mode === 'seeded') {
    const fixture = await prisma.memoryFixture.findUnique({
      where: { name_hash: { name: settings.memory.fixture ?? '', hash: settings.memory.fixture_hash ?? '' } },
    });
    if (!fixture) {
      throw new SpecBuildError(`memory fixture ${settings.memory.fixture}@${settings.memory.fixture_hash} is no longer stored (D-5)`);
    }
    const files = fixture.files as Record<string, string>;
    memorySeed = Object.fromEntries(Object.entries(files).filter(([k]) => k === 'MEMORY.md' || k === 'USER.md'));
  }

  let judgeModel;
  try {
    judgeModel = await resolveJudgeModel(prisma, task.graders as unknown[]);
  } catch (e) {
    if (e instanceof HttpException) throw new SpecBuildError(e.message);
    throw e;
  }

  const failureTask: FailureTask = { taskCategory: task.category, taskFixtureDir: task.fixtureDir, memoryMode: settings.memory?.mode === 'seeded' ? 'seeded' : 'off' };
  const spec: TrialSpec = {
    trial_id: c.trialId,
    attempt: c.attemptNo,
    seed: c.seed,
    harness: config.harnessId,
    model: {
      id: config.model.id,
      slug: config.model.slug,
      base_url: config.model.baseUrl,
      api_key_env: config.model.apiKeyEnv,
      input_price_per_mtok: c.price.input_price_per_mtok,
      output_price_per_mtok: c.price.output_price_per_mtok,
      context_window: config.model.contextWindow,
    },
    settings,
    task: {
      id: task.id,
      version_hash: task.versionHash,
      prompt: task.prompt,
      fixture_dir: task.fixtureDir,
      memory_fixture: task.memoryFixture,
      graders: task.graders as unknown[],
    },
    memory_seed: memorySeed,
    ...(judgeModel ? { judge_model: judgeModel } : {}),
  };
  return { spec, failureTask };
}

export interface WorkerOutcome {
  ingested: IngestedTrial;
  /** Set when the outcome caps the attempts (the 5 MB trace rule retries once). */
  maxAttempts?: number;
}

/**
 * Calls the worker and routes whatever comes back. Failure mapping (brief): HTTP 429 is backpressure; any other thrown
 * error is worker_crash; a result the API cannot store is worker_crash "worker result rejected" (an oversized trace
 * gets 1 retry); an errored TrialResult keeps its own error_class.
 */
export async function runOnWorker(
  worker: Pick<WorkerClient, 'runTrial'>,
  spec: TrialSpec,
  price: PriceSnapshot,
  failureTask?: FailureTask,
): Promise<WorkerOutcome> {
  let result: TrialResult;
  try {
    result = await worker.runTrial(spec);
  } catch (e) {
    if (workerHttpStatus(e) === 429) {
      return { ingested: ingest(erroredResult('backpressure', (e as Error).message), price) };
    }
    const message = e instanceof WorkerUnavailableError ? e.message : `worker call failed: ${(e as Error).message}`;
    return { ingested: ingest(erroredResult('worker_crash', message), price) };
  }
  try {
    return { ingested: ingest(result, price, failureTask) };
  } catch (e) {
    if (!(e instanceof IngestError)) throw e;
    // An oversized trace is the very thing the 5 MB cap (DATA_MODEL 2.9) keeps out of the database, so it is not kept as a partial trace.
    const oversized = e.message.startsWith('trace is larger than');
    const partial = oversized ? null : (result.trace?.events ?? result.partial_trace);
    return {
      ingested: ingest(erroredResult('worker_crash', `worker result rejected: ${e.message}`, partial), price),
      ...(oversized ? { maxAttempts: 2 } : {}),
    };
  }
}
