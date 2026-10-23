import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { Prisma } from '../generated/prisma/client';
import { ulid } from '../common/ulid';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsJson, TrialResult, TrialSpec } from '../worker-client/types';
import { WorkerClient, WorkerUnavailableError } from '../worker-client/worker-client';
import { erroredResult, IngestedTrial, ingest, IngestError, PriceSnapshot } from './ingest';
import { resolveJudgeModel } from '../judge/judge-model';
import { trialSeed } from './seed';
import { TrialsQuery } from './trials.query';

const Body = z.object({ config_id: z.string().min(1), task_id: z.string().min(1) }).strict();

/** The base seed of an ad hoc experiment. Fixed, so the same (config, task) always gets the same trial seed. */
const ADHOC_SEED = 1;

/**
 * POST /trials/adhoc: 1 trial, dispatched synchronously. Creates an experiment "adhoc-<ulid>"
 * (n_trials 1, phase full, status running) with 1 config and 1 pinned task version, runs the
 * trial on the worker, ingests the result and settles the experiment. No concurrency and no
 * retry: the scheduler that replaces this dispatch arrives in P3.
 */
@Injectable()
export class AdhocService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly worker: WorkerClient,
    private readonly queries: TrialsQuery,
  ) {}

  async run(raw: unknown) {
    const parsed = Body.safeParse(raw);
    if (!parsed.success) {
      throw new BadRequestException({ message: 'body must be {config_id, task_id}', issues: parsed.error.issues.map((i) => i.message) });
    }
    const { config_id: configId, task_id: taskId } = parsed.data;

    const config = await this.prisma.config.findUnique({ where: { id: configId }, include: { model: true } });
    if (!config) throw new NotFoundException(`config ${configId} not found`);
    const task = await this.prisma.task.findFirst({ where: { id: taskId, isCurrent: true } });
    if (!task) throw new NotFoundException(`task ${taskId} has no current version; POST /tasks/sync?`);

    const settings = config.settings as unknown as SettingsJson;
    let memorySeed: Record<string, string> | null = null;
    if (settings.memory.mode === 'seeded') {
      const fixture = await this.prisma.memoryFixture.findUnique({
        where: { name_hash: { name: settings.memory.fixture ?? '', hash: settings.memory.fixture_hash ?? '' } },
      });
      if (!fixture) {
        throw new ConflictException(`memory fixture ${settings.memory.fixture}@${settings.memory.fixture_hash} is no longer stored (D-5)`);
      }
      const files = fixture.files as Record<string, string>;
      memorySeed = Object.fromEntries(Object.entries(files).filter(([k]) => k === 'MEMORY.md' || k === 'USER.md'));
    }

    const price: PriceSnapshot = {
      input_price_per_mtok: config.model.inputPricePerMtok.toNumber(),
      output_price_per_mtok: config.model.outputPricePerMtok.toNumber(),
    };

    const judgeModel = await resolveJudgeModel(this.prisma, task.graders as unknown[]);

    let manifest: unknown = {};
    try {
      manifest = await this.worker.adapters();
    } catch {
      // The snapshot is informational; a worker that cannot answer will fail the run below.
    }

    const experimentId = ulid();
    const trialId = ulid();
    const seed = trialSeed(ADHOC_SEED, config.id, task.id, 0);
    const startedAt = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.experiment.create({
        data: {
          id: experimentId,
          name: `adhoc-${experimentId}`,
          status: 'running',
          nTrials: 1,
          seed: ADHOC_SEED,
          phase: 'full',
          workerManifest: manifest as Prisma.InputJsonValue,
          startedAt,
        },
      });
      await tx.experimentConfig.create({ data: { experimentId, configId: config.id, position: 0 } });
      await tx.experimentTask.create({ data: { experimentId, taskId: task.id, taskVersionHash: task.versionHash } });
      await tx.trial.create({
        data: {
          id: trialId,
          experimentId,
          configId: config.id,
          taskId: task.id,
          taskVersionHash: task.versionHash,
          trialIndex: 0,
          seed,
          status: 'running',
          attemptCount: 1,
          priceSnapshot: price as unknown as Prisma.InputJsonValue, // D-7
          startedAt,
          heartbeatAt: startedAt,
        },
      });
      // Written before the HTTP call, so a crash of the API mid-call leaves evidence (DATA_MODEL 2.8).
      await tx.trialAttempt.create({ data: { id: ulid(), trialId, attemptNo: 1, startedAt } });
    });

    const spec: TrialSpec = {
      trial_id: trialId,
      attempt: 1,
      seed,
      harness: config.harnessId,
      model: {
        id: config.model.id,
        slug: config.model.slug,
        base_url: config.model.baseUrl,
        api_key_env: config.model.apiKeyEnv,
        input_price_per_mtok: price.input_price_per_mtok,
        output_price_per_mtok: price.output_price_per_mtok,
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

    let result: TrialResult;
    try {
      result = await this.worker.runTrial(spec);
    } catch (e) {
      result = erroredResult('worker_crash', e instanceof WorkerUnavailableError ? e.message : `worker call failed: ${(e as Error).message}`);
    }

    let ingested: IngestedTrial;
    try {
      ingested = ingest(result, price);
    } catch (e) {
      if (!(e instanceof IngestError)) throw e;
      ingested = ingest(erroredResult('worker_crash', `worker result rejected: ${e.message}`, result.trace?.events ?? result.partial_trace), price);
    }

    await this.settle(experimentId, trialId, config.modelSlug, ingested);
    return this.queries.fullTrial(trialId);
  }

  private async settle(experimentId: string, trialId: string, modelSlug: string, r: IngestedTrial): Promise<void> {
    const endedAt = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.trial.update({
        where: { id: trialId },
        data: {
          status: r.status,
          passed: r.passed,
          exitReason: r.exitReason,
          steps: r.steps,
          inputTokens: r.inputTokens,
          outputTokens: r.outputTokens,
          cacheReadTokens: r.cacheReadTokens,
          reasoningTokens: r.reasoningTokens,
          apiCalls: r.apiCalls,
          latencyMs: r.latencyMs,
          costUsd: r.costUsd,
          harnessCostUsd: r.harnessCostUsd,
          rateLimitEvents: r.rateLimitEvents,
          errorClass: r.errorClass,
          errorMessage: r.errorMessage,
          endedAt,
        },
      });
      if (r.trace) {
        await tx.trace.create({
          data: {
            trialId,
            harnessId: r.trace.harnessId,
            harnessVersion: r.trace.harnessVersion,
            modelSlug,
            systemPrompt: r.trace.systemPrompt,
            events: r.trace.events as unknown as Prisma.InputJsonValue,
            memoryInitial: r.trace.memoryInitial,
            memoryFinal: r.trace.memoryFinal,
            skillsInvoked: r.trace.skillsInvoked,
            notes: r.trace.notes,
            finalResponse: r.trace.finalResponse,
          },
        });
      }
      for (const g of r.graders) {
        await tx.graderResult.create({
          data: {
            id: ulid(),
            trialId,
            graderIndex: g.grader_index,
            graderType: g.grader_type,
            passed: g.passed,
            details: g.details as Prisma.InputJsonValue,
            reasoning: g.reasoning,
            judgeModelId: g.judge_model_id,
            judgePromptHash: g.judge_prompt_hash,
            durationMs: g.duration_ms,
          },
        });
      }
      await tx.trialAttempt.update({
        where: { trialId_attemptNo: { trialId, attemptNo: 1 } },
        data: {
          endedAt,
          result: r.status === 'done' ? 'done' : 'errored',
          errorClass: r.errorClass,
          errorMessage: r.errorMessage,
          partialTrace: r.partialTrace ? (r.partialTrace as unknown as Prisma.InputJsonValue) : undefined,
        },
      });
      // Derived, never set by hand (DATA_MODEL 2.6): completed iff every trial is done, else partial (D-8).
      await tx.experiment.update({ where: { id: experimentId }, data: { status: r.status === 'done' ? 'completed' : 'partial', finishedAt: endedAt } });
    });
  }
}
