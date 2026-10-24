import { isDeepStrictEqual } from 'node:util';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { ulid } from '../common/ulid';
import { Prisma } from '../generated/prisma/client';
import { JudgePolicy, judgePolicy } from '../judge/policy';
import { PrismaService } from '../prisma/prisma.service';
import { compare, ComparePayload, CompareTask, CompareTrial, DEFAULT_RESAMPLES } from '../stats/compare';
import { pilot, PilotPayload } from '../stats/pilot';
import { STATS_VERSION } from '../stats/version';

const QueryShape = z.object({
  a: z.string().min(1).optional(),
  b: z.string().min(1).optional(),
  persist: z.enum(['1', 'true', '0', 'false']).optional(),
});

export interface CompareQuery {
  a?: string;
  b?: string;
  persist?: boolean | string;
}

export type ComparePayloadWithRun = ComparePayload & { comparison_run_id?: string };

/**
 * The experiment, its trials, its tasks and the judge rows are read in ONE snapshot: a trial that settles between 2 of
 * those reads would otherwise give a payload that matches no real state of the experiment. The ExportService opens the
 * same transaction and hands it to compute(), so the export's trials and its comparison agree too.
 */
export const SNAPSHOT_TX = {
  isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
  timeout: 60_000,
  maxWait: 10_000,
} as const;

/** Most restrictive first: when 2 judges disagree, the stricter policy decides (DESIGN 8.4). */
const RESTRICTIVENESS: Record<JudgePolicy, number> = { excluded: 2, flagged: 1, trusted: 0 };

interface JudgeInUse {
  policy: JudgePolicy;
  modelId: string | null;
  promptHash: string | null;
  kappa: number | null;
}

@Injectable()
export class CompareService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * GET /experiments/:id/compare. Scores ALL trials of the 2 configs in any status: compare() counts the
   * errored, cancelled and unfinished ones, nothing is dropped here (card section 5). With `persist` it also
   * stores a comparison_run (DATA_MODEL 2.13) and returns its id; when the newest stored run for the same (experiment,
   * a, b, stats_version, seed, resamples) already holds an equal result, that run's id is returned and no row is added.
   * Without `tx` it opens its own RepeatableRead transaction (SNAPSHOT_TX); with one, it reads and writes through it.
   */
  async compute(experimentId: string, query: CompareQuery = {}, tx?: Prisma.TransactionClient): Promise<ComparePayloadWithRun> {
    if (!tx) return this.prisma.$transaction((t) => this.compute(experimentId, query, t), SNAPSHOT_TX);
    const experiment = await tx.experiment.findUnique({
      where: { id: experimentId },
      include: { configs: { include: { config: true }, orderBy: { position: 'asc' } }, tasks: true },
    });
    if (!experiment) throw new NotFoundException(`experiment ${experimentId} not found`);

    const q = this.parseQuery(query);
    const [aId, bId] = this.pick(
      experiment.configs.map((c) => c.configId),
      q,
    );
    const configA = experiment.configs.find((c) => c.configId === aId)!.config;
    const configB = experiment.configs.find((c) => c.configId === bId)!.config;

    const taskRows =
      experiment.tasks.length === 0
        ? []
        : await tx.task.findMany({ where: { OR: experiment.tasks.map((t) => ({ id: t.taskId, versionHash: t.taskVersionHash })) } });
    const tasks: CompareTask[] = taskRows.map((t) => ({ id: t.id, category: t.category, judged: hasJudgeGrader(t.graders) }));

    const trialRows = await tx.trial.findMany({ where: { experimentId, configId: { in: [aId, bId] } } });
    const trials: CompareTrial[] = trialRows.map((t) => ({
      configId: t.configId,
      taskId: t.taskId,
      trialIndex: t.trialIndex,
      status: t.status,
      passed: t.passed,
      costUsd: t.costUsd === null ? null : t.costUsd.toNumber(),
      latencyMs: t.latencyMs,
      inputTokens: t.inputTokens,
      outputTokens: t.outputTokens,
      rateLimitEvents: t.rateLimitEvents,
    }));

    const judge = await this.judgeInUse(
      tx,
      experimentId,
      [aId, bId],
      tasks.some((t) => t.judged),
    );
    const payload = compare(
      {
        experimentId,
        axis: experiment.axis,
        configA: { id: configA.id, name: configA.name },
        configB: { id: configB.id, name: configB.name },
        nTrialsPerTask: experiment.nTrials,
        tasks,
        trials,
      },
      { seed: experiment.seed, resamples: DEFAULT_RESAMPLES, judge },
    );
    if (!q.persist) return payload;

    // Persist dedupe: the same inputs give the same result (the resampling is seeded), so an equal newest row is reused, not repeated.
    const key = { experimentId, configAId: aId, configBId: bId, statsVersion: STATS_VERSION, seed: experiment.seed, resamples: DEFAULT_RESAMPLES };
    const newest = await tx.comparisonRun.findFirst({ where: key, orderBy: [{ computedAt: 'desc' }, { id: 'desc' }] });
    if (newest && isDeepStrictEqual(newest.result, JSON.parse(JSON.stringify(payload)))) return { ...payload, comparison_run_id: newest.id };

    const id = ulid();
    await tx.comparisonRun.create({ data: { id, ...key, judgePolicyApplied: payload.judge_policy_applied, result: payload as never } });
    return { ...payload, comparison_run_id: id };
  }

  /** GET /experiments/:id/pilot: variance and projected widths of ALL configs' trials, never a delta (DESIGN 9.7). */
  async pilot(experimentId: string): Promise<PilotPayload> {
    const experiment = await this.prisma.experiment.findUnique({
      where: { id: experimentId },
      include: { configs: true, tasks: { include: { task: { select: { graders: true } } } } },
    });
    if (!experiment) throw new NotFoundException(`experiment ${experimentId} not found`);
    const trials = await this.prisma.trial.findMany({
      where: { experimentId },
      select: { configId: true, taskId: true, status: true, passed: true },
    });
    return pilot({
      experimentId,
      nConfigs: experiment.configs.length,
      tasks: experiment.tasks.map((t) => ({ id: t.taskId, judged: hasJudgeGrader(t.task.graders) })),
      trials,
      nPilot: experiment.nTrials,
    });
  }

  private parseQuery(query: CompareQuery): { a?: string; b?: string; persist: boolean } {
    const r = QueryShape.safeParse({ a: query.a, b: query.b, persist: query.persist === undefined ? undefined : String(query.persist) });
    if (!r.success) {
      throw new BadRequestException({ message: 'invalid compare query', issues: r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) });
    }
    return { a: r.data.a, b: r.data.b, persist: r.data.persist === '1' || r.data.persist === 'true' };
  }

  /**
   * a and b default to the first 2 configs by position only when the experiment has exactly 2; with 2 configs and
   * only 1 given, the other is the remaining config. Otherwise both are required.
   */
  private pick(configIds: string[], q: { a?: string; b?: string }): [string, string] {
    let { a, b } = q;
    if (configIds.length === 2) {
      if (a === undefined && b === undefined) [a, b] = configIds;
      else if (a === undefined) a = configIds.find((id) => id !== b);
      else if (b === undefined) b = configIds.find((id) => id !== a);
    }
    if (a === undefined || b === undefined) {
      throw new BadRequestException(`this experiment has ${configIds.length} configs: pass both a and b (config ids)`);
    }
    for (const [name, id] of [
      ['a', a],
      ['b', b],
    ] as const) {
      if (!configIds.includes(id)) throw new BadRequestException(`${name} = ${id} is not a config of this experiment`);
    }
    if (a === b) throw new BadRequestException('a and b must be different configs');
    return [a, b];
  }

  /**
   * DESIGN 8.4 / D-16. The judges in use are the distinct (model, prompt hash) pairs of the experiment's llm_judge
   * grader rows. Each pair's policy comes from its latest judge_validation row, re-derived from the stored kappa
   * (so a hand-edited policy column cannot loosen it); no row means excluded. The most restrictive pair wins.
   * Judged tasks but no judge rows yet: excluded. No judged task: trusted, no judge. Only the grader rows of the trials of
   * the 2 compared configs count: a third config that used another, unvalidated judge must not change the a-vs-b policy.
   */
  private async judgeInUse(tx: Prisma.TransactionClient, experimentId: string, configIds: string[], anyJudgedTask: boolean): Promise<JudgeInUse> {
    if (!anyJudgedTask) return { policy: 'trusted', modelId: null, promptHash: null, kappa: null };

    const pairs = await tx.graderResult.findMany({
      where: {
        graderType: 'llm_judge',
        judgeModelId: { not: null },
        judgePromptHash: { not: null },
        trial: { experimentId, configId: { in: configIds } },
      },
      select: { judgeModelId: true, judgePromptHash: true },
      distinct: ['judgeModelId', 'judgePromptHash'],
      orderBy: [{ judgeModelId: 'asc' }, { judgePromptHash: 'asc' }],
    });
    if (pairs.length === 0) return { policy: 'excluded', modelId: null, promptHash: null, kappa: null };

    const judges: JudgeInUse[] = [];
    for (const p of pairs) {
      const modelId = p.judgeModelId!;
      const promptHash = p.judgePromptHash!;
      const row = await tx.judgeValidation.findFirst({
        where: { judgeModelId: modelId, judgePromptHash: promptHash },
        orderBy: [{ computedAt: 'desc' }, { id: 'desc' }],
      });
      const kappa = row ? row.kappa.toNumber() : null;
      judges.push({ policy: judgePolicy(kappa), modelId, promptHash, kappa });
    }
    // Stable sort: among equally restrictive pairs the first by (model, prompt hash) is reported.
    return judges.sort((x, y) => RESTRICTIVENESS[y.policy] - RESTRICTIVENESS[x.policy])[0];
  }
}

export function hasJudgeGrader(graders: unknown): boolean {
  return Array.isArray(graders) && graders.some((g) => typeof g === 'object' && g !== null && (g as { type?: unknown }).type === 'llm_judge');
}
