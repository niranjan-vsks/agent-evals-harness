import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { Prisma } from '../generated/prisma/client';
import { ulid } from '../common/ulid';
import { PrismaService } from '../prisma/prisma.service';
import { Scheduler } from '../scheduler/scheduler';
import { SettingsJson } from '../worker-client/types';
import { WorkerClient } from '../worker-client/worker-client';
import { PriceSnapshot } from './ingest';
import { resolveJudgeModel } from '../judge/judge-model';
import { trialSeed } from './seed';
import { TrialsQuery } from './trials.query';

const Body = z.object({ config_id: z.string().min(1), task_id: z.string().min(1) }).strict();

/** The base seed of an ad hoc experiment. Fixed, so the same (config, task) always gets the same trial seed. */
const ADHOC_SEED = 1;

/**
 * POST /trials/adhoc: 1 trial, run synchronously through the scheduler (P3 card section 1: 1 dispatch path). Creates a
 * `draft` experiment "adhoc-<ulid>" (n_trials 1, phase full) with 1 config, 1 pinned task version and 1 `pending` trial in
 * 1 transaction, then Scheduler.runNow claims it (the claim promotes the draft to running via the `adhoc` transition),
 * dispatches it with no retry, ingests the result and derives the experiment status. Spec building, ingest and settle
 * live in the scheduler; this service only checks what must fail BEFORE a row exists.
 */
@Injectable()
export class AdhocService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly worker: WorkerClient,
    private readonly scheduler: Scheduler,
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

    // Both checks are also made when the scheduler builds the spec, where a failure ends the trial config_invalid. For a direct
    // request they must answer 409 and leave no experiment row behind, so they run here first.
    const settings = config.settings as unknown as SettingsJson;
    if (settings.memory.mode === 'seeded') {
      const fixture = await this.prisma.memoryFixture.findUnique({
        where: { name_hash: { name: settings.memory.fixture ?? '', hash: settings.memory.fixture_hash ?? '' } },
      });
      if (!fixture) {
        throw new ConflictException(`memory fixture ${settings.memory.fixture}@${settings.memory.fixture_hash} is no longer stored (D-5)`);
      }
    }
    await resolveJudgeModel(this.prisma, task.graders as unknown[]);

    let manifest: unknown = {};
    try {
      manifest = await this.worker.adapters();
    } catch {
      // The snapshot is informational; a worker that cannot answer will fail the run below.
    }

    // D-7: a placeholder. The claim overwrites it with the model's prices at the moment of dispatch.
    const price: PriceSnapshot = {
      input_price_per_mtok: config.model.inputPricePerMtok.toNumber(),
      output_price_per_mtok: config.model.outputPricePerMtok.toNumber(),
    };
    const experimentId = ulid();
    const trialId = ulid();
    await this.prisma.$transaction(async (tx) => {
      await tx.experiment.create({
        data: {
          id: experimentId,
          name: `adhoc-${experimentId}`,
          status: 'draft',
          nTrials: 1,
          seed: ADHOC_SEED,
          phase: 'full',
          workerManifest: manifest as Prisma.InputJsonValue,
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
          seed: trialSeed(ADHOC_SEED, config.id, task.id, 0),
          status: 'pending',
          attemptCount: 0,
          priceSnapshot: price as unknown as Prisma.InputJsonValue,
        },
      });
    });

    // Rejects only when the outcome could not be stored: a worker failure is a stored errored trial, not an exception.
    await this.scheduler.runNow(trialId);
    return this.queries.fullTrial(trialId);
  }
}
