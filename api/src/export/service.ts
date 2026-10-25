import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { CompareService, ComparePayloadWithRun, SNAPSHOT_TX } from '../compare/service';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CsvValue, toCsv } from './csv';

/** DATA_MODEL 5, in this order. */
export const EXPORT_CSV_COLUMNS = [
  'trial_id',
  'config_id',
  'config_name',
  'task_id',
  'task_category',
  'trial_index',
  'status',
  'passed',
  'exit_reason',
  'steps',
  'input_tokens',
  'output_tokens',
  'cost_usd',
  'latency_ms',
  'rate_limit_events',
  'error_class',
  'failure_category',
] as const;

export const COMPARE_CSV_COLUMNS = ['task_id', 'category', 'n_a', 'n_b', 'rate_a', 'rate_b', 'delta', 'ci_low', 'ci_high', 'verdict'] as const;

export const AGGREGATE_ROW_ID = '__aggregate__';
/** compare.csv verdicts that are not a statistical verdict. */
export const VERDICT_JUDGE_EXCLUDED = 'judge_excluded';
export const VERDICT_UNPAIRED = 'unpaired';
/** ?traces=1 puts every trial's events in one response body; past this many trials it is refused (400). */
export const MAX_TRACE_EXPORT_TRIALS = 2000;

const Flag = z.enum(['1', 'true', '0', 'false']);
const ExportQuery = z.object({ a: z.string().min(1).optional(), b: z.string().min(1).optional(), traces: Flag.optional() });
const CompareCsvQuery = z.object({ a: z.string().min(1).optional(), b: z.string().min(1).optional() });

export interface ExportQueryInput {
  a?: unknown;
  b?: unknown;
  traces?: unknown;
}

function parseQuery<T extends z.ZodTypeAny>(schema: T, raw: unknown): z.infer<T> {
  const r = schema.safeParse(raw ?? {});
  if (!r.success) {
    throw new BadRequestException({ message: 'invalid export query', issues: r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) });
  }
  return r.data;
}

const num = (d: { toNumber(): number } | null): number | null => (d ? d.toNumber() : null);

@Injectable()
export class ExportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly compare: CompareService,
  ) {}

  /**
   * GET /experiments/:id/export.json. The experiment, its trials and the comparison are read in ONE RepeatableRead transaction,
   * so a trial that settles meanwhile cannot make the trials and the comparison disagree. When the experiment has exactly 2
   * configs, or ?a=&b= are given, the comparison is computed first and stored as a comparison_run (an unchanged experiment
   * reuses its newest equal row, a changed one adds a row), so the export is reproducible from that row; `comparison_run_id`
   * names the row this export used and is null when no comparison was computed (3 or more configs and no a/b: comparison_runs
   * then lists whatever is stored). Traces are left out unless ?traces=1, which is refused with 400 above
   * MAX_TRACE_EXPORT_TRIALS trials: the whole export is one response body.
   */
  async json(experimentId: string, rawQuery: ExportQueryInput = {}) {
    const q = parseQuery(ExportQuery, rawQuery);
    return this.prisma.$transaction((tx) => this.jsonIn(tx, experimentId, q), SNAPSHOT_TX);
  }

  private async jsonIn(tx: Prisma.TransactionClient, experimentId: string, q: z.infer<typeof ExportQuery>) {
    const experiment = await tx.experiment.findUnique({
      where: { id: experimentId },
      include: {
        configs: { include: { config: true }, orderBy: { position: 'asc' } },
        tasks: { include: { task: true }, orderBy: { taskId: 'asc' } },
      },
    });
    if (!experiment) throw new NotFoundException(`experiment ${experimentId} not found`);

    const withTraces = q.traces === '1' || q.traces === 'true';
    if (withTraces) {
      const n = await tx.trial.count({ where: { experimentId } });
      if (n > MAX_TRACE_EXPORT_TRIALS) {
        throw new BadRequestException(`traces=1 is refused above ${MAX_TRACE_EXPORT_TRIALS} trials (this experiment has ${n}); fetch GET /trials/:id/trace per trial`);
      }
    }

    let comparisonRunId: string | null = null;
    if (experiment.configs.length === 2 || q.a !== undefined || q.b !== undefined) {
      // 400 for a bad a or b, before anything else is read
      const payload = await this.compare.compute(experimentId, { a: q.a, b: q.b, persist: true }, tx);
      comparisonRunId = payload.comparison_run_id ?? null;
    }

    const position = new Map(experiment.configs.map((c) => [c.configId, c.position]));
    const trials = await tx.trial.findMany({
      where: { experimentId },
      include: {
        graders: { orderBy: { graderIndex: 'asc' } },
        ...(withTraces ? { trace: true, attempts: { orderBy: { attemptNo: 'desc' as const }, take: 1 } } : {}),
      },
    });
    trials.sort((x, y) => (position.get(x.configId) ?? 0) - (position.get(y.configId) ?? 0) || cmp(x.taskId, y.taskId) || x.trialIndex - y.trialIndex);
    const runs = await tx.comparisonRun.findMany({ where: { experimentId }, orderBy: [{ computedAt: 'asc' }, { id: 'asc' }] });

    return {
      experiment: {
        id: experiment.id,
        name: experiment.name,
        status: experiment.status,
        n_trials: experiment.nTrials,
        seed: experiment.seed,
        phase: experiment.phase,
        axis: experiment.axis,
        hypothesis: experiment.hypothesis,
        worker_manifest: experiment.workerManifest,
        created_at: experiment.createdAt,
        started_at: experiment.startedAt,
        finished_at: experiment.finishedAt,
        pause_reason: experiment.pauseReason,
      },
      configs: experiment.configs.map((c) => ({
        id: c.configId,
        name: c.config.name,
        position: c.position,
        harness_id: c.config.harnessId,
        harness_version: c.config.harnessVersion,
        model_id: c.config.modelId,
        model_slug: c.config.modelSlug,
        settings: c.config.settings,
        config_hash: c.config.configHash,
      })),
      tasks: experiment.tasks.map((t) => ({
        task_id: t.taskId,
        task_version_hash: t.taskVersionHash,
        category: t.task.category,
        prompt: t.task.prompt,
        fixture_dir: t.task.fixtureDir,
        memory_fixture: t.task.memoryFixture,
        graders: t.task.graders,
        discriminates: t.task.discriminates,
        tags: t.task.tags,
      })),
      trials: trials.map((t) => ({
        id: t.id,
        experiment_id: t.experimentId,
        config_id: t.configId,
        task_id: t.taskId,
        task_version_hash: t.taskVersionHash,
        trial_index: t.trialIndex,
        seed: t.seed,
        status: t.status,
        attempt_count: t.attemptCount,
        passed: t.passed,
        exit_reason: t.exitReason,
        steps: t.steps,
        input_tokens: t.inputTokens,
        output_tokens: t.outputTokens,
        cache_read_tokens: t.cacheReadTokens,
        reasoning_tokens: t.reasoningTokens,
        api_calls: t.apiCalls,
        latency_ms: t.latencyMs,
        cost_usd: num(t.costUsd),
        harness_cost_usd: num(t.harnessCostUsd),
        price_snapshot: t.priceSnapshot,
        rate_limit_events: t.rateLimitEvents,
        error_class: t.errorClass,
        error_message: t.errorMessage,
        failure_category: t.failureCategory,
        failure_evidence: t.failureEvidence,
        started_at: t.startedAt,
        ended_at: t.endedAt,
        grader_results: t.graders.map((g) => ({
          grader_index: g.graderIndex,
          grader_type: g.graderType,
          passed: g.passed,
          details: g.details,
          reasoning: g.reasoning,
          judge_model_id: g.judgeModelId,
          judge_prompt_hash: g.judgePromptHash,
          duration_ms: g.durationMs,
        })),
        ...(withTraces ? { trace: traceOf(t as TrialWithTrace) } : {}),
      })),
      comparison_runs: runs.map((r) => ({
        id: r.id,
        config_a_id: r.configAId,
        config_b_id: r.configBId,
        computed_at: r.computedAt,
        stats_version: r.statsVersion,
        seed: r.seed,
        resamples: r.resamples,
        judge_policy_applied: r.judgePolicyApplied,
        result: r.result,
      })),
      comparison_run_id: comparisonRunId,
    };
  }

  /** GET /experiments/:id/export.csv: 1 row per trial, ordered by config position, task id, trial index. */
  async trialsCsv(experimentId: string): Promise<string> {
    const experiment = await this.prisma.experiment.findUnique({
      where: { id: experimentId },
      include: { configs: { include: { config: true }, orderBy: { position: 'asc' } }, tasks: { include: { task: true } } },
    });
    if (!experiment) throw new NotFoundException(`experiment ${experimentId} not found`);

    const config = new Map(experiment.configs.map((c) => [c.configId, c]));
    const category = new Map(experiment.tasks.map((t) => [t.taskId, t.task.category]));
    const trials = await this.prisma.trial.findMany({ where: { experimentId } });
    const pos = (id: string) => config.get(id)?.position ?? 0;
    trials.sort((x, y) => pos(x.configId) - pos(y.configId) || cmp(x.taskId, y.taskId) || x.trialIndex - y.trialIndex);

    const rows: CsvValue[][] = trials.map((t) => [
      t.id,
      t.configId,
      config.get(t.configId)?.config.name ?? null,
      t.taskId,
      category.get(t.taskId) ?? null,
      t.trialIndex,
      t.status,
      t.passed,
      t.exitReason,
      t.steps,
      t.inputTokens,
      t.outputTokens,
      t.costUsd === null ? null : t.costUsd.toFixed(), // the exact stored decimal, never an exponent
      t.latencyMs,
      t.rateLimitEvents,
      t.errorClass,
      t.failureCategory,
    ]);
    return toCsv(EXPORT_CSV_COLUMNS, rows);
  }

  /**
   * GET /experiments/:id/compare.csv?a=&b=: 1 row per paired task of the comparison (verdict `judge_excluded` with a blank
   * interval for a task the judge policy withheld), 1 row per unpaired task (verdict `unpaired`, blank rates and interval), then
   * `__aggregate__` (category empty). Stores a comparison_run like the compare endpoint with persist. The aggregate's n_a and
   * n_b are the scored `done` trials per side that entered the headline: the per_task rows that are not judge_excluded, whose
   * total is the payload's n_scored. An unpaired row's n_a and n_b are the same kind of count (done trials with a verdict) read
   * in the same snapshot, so the side that has none shows 0.
   */
  async compareCsv(experimentId: string, rawQuery: ExportQueryInput = {}): Promise<string> {
    const q = parseQuery(CompareCsvQuery, rawQuery);
    return this.prisma.$transaction(async (tx) => {
      const payload = await this.compare.compute(experimentId, { a: q.a, b: q.b, persist: true }, tx);
      const info = new Map<string, UnpairedInfo>();
      const ids = payload.unpaired_tasks.map((u) => u.task_id);
      if (ids.length > 0) {
        const pinned = await tx.experimentTask.findMany({ where: { experimentId, taskId: { in: ids } }, include: { task: { select: { category: true } } } });
        const counts = await tx.trial.groupBy({
          by: ['taskId', 'configId'],
          where: { experimentId, taskId: { in: ids }, configId: { in: [payload.config_a.id, payload.config_b.id] }, status: 'done', passed: { not: null } },
          _count: { _all: true },
        });
        const n = (taskId: string, configId: string) => counts.find((c) => c.taskId === taskId && c.configId === configId)?._count._all ?? 0;
        for (const t of pinned) {
          info.set(t.taskId, { category: t.task.category, n_a: n(t.taskId, payload.config_a.id), n_b: n(t.taskId, payload.config_b.id) });
        }
      }
      return compareCsvOf(payload, info);
    }, SNAPSHOT_TX);
  }
}

export interface UnpairedInfo {
  category: string;
  n_a: number;
  n_b: number;
}

type CsvSource = Pick<ComparePayloadWithRun, 'per_task' | 'aggregate'> & { unpaired_tasks?: ComparePayloadWithRun['unpaired_tasks'] };

/** The payload as CSV rows. Exported for the unit spec. `unpaired` supplies the category and counts of unpaired tasks (blank when absent). */
export function compareCsvOf(p: CsvSource, unpaired: ReadonlyMap<string, UnpairedInfo> = new Map()): string {
  const rows: CsvValue[][] = p.per_task.map((r) =>
    r.judge_excluded
      ? [r.task_id, r.category, r.n_a, r.n_b, r.rate_a, r.rate_b, r.delta, null, null, VERDICT_JUDGE_EXCLUDED]
      : [r.task_id, r.category, r.n_a, r.n_b, r.rate_a, r.rate_b, r.delta, r.ci_low, r.ci_high, r.verdict],
  );
  for (const u of p.unpaired_tasks ?? []) {
    const i = unpaired.get(u.task_id);
    rows.push([u.task_id, i?.category ?? '', i?.n_a ?? null, i?.n_b ?? null, null, null, null, null, null, VERDICT_UNPAIRED]);
  }
  const headline = p.per_task.filter((r) => !r.judge_excluded);
  const a = p.aggregate;
  rows.push([
    AGGREGATE_ROW_ID,
    '',
    headline.reduce((n, r) => n + r.n_a, 0),
    headline.reduce((n, r) => n + r.n_b, 0),
    a.p_a,
    a.p_b,
    a.delta,
    a.ci_low,
    a.ci_high,
    a.verdict,
  ]);
  return toCsv(COMPARE_CSV_COLUMNS, rows);
}

const cmp = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);

type TrialWithTrace = Prisma.TrialGetPayload<{ include: { trace: true; attempts: true } }>;

/** The stored trace, or for an errored trial the partial events of its last attempt (as GET /trials/:id/trace). */
function traceOf(t: TrialWithTrace) {
  if (t.trace) {
    return {
      trial_id: t.trace.trialId,
      schema_version: t.trace.schemaVersion,
      harness_id: t.trace.harnessId,
      harness_version: t.trace.harnessVersion,
      model_slug: t.trace.modelSlug,
      system_prompt: t.trace.systemPrompt,
      events: t.trace.events,
      memory_initial: t.trace.memoryInitial,
      memory_final: t.trace.memoryFinal,
      skills_invoked: t.trace.skillsInvoked,
      notes: t.trace.notes,
      final_response: t.trace.finalResponse,
    };
  }
  const attempt = t.attempts[0];
  if (!attempt) return null;
  return { trial_id: t.id, partial: true, events: attempt.partialTrace ?? [], error_class: attempt.errorClass, error_message: attempt.errorMessage };
}
