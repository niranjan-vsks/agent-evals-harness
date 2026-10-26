import { Injectable } from '@nestjs/common';
import { SNAPSHOT_TX } from '../compare/service';
import { FAILURE_CATEGORIES, FailureCategory } from '../failures/rules';
import { PrismaService } from '../prisma/prisma.service';
import type { AggregateBlock, ComparePayload } from '../stats/compare';

/**
 * GET /summary (cards/P8.md section 4): the home dashboard. A view over stored rows and persisted comparisons; it computes no
 * statistic. Verdicts come only from comparison_run rows, so the dashboard cannot disagree with a Compare page. The per-config
 * means are the macro average of DESIGN 9.1 (per-task mean over done trials, then the mean over tasks), the same arithmetic
 * compare.ts uses for p_a and p_b and for its cost, latency and token means.
 */

export const LATEST_COMPARISONS = 5;
export const RECENT_EXPERIMENTS = 8;

/** The trial fields the summary reads; only done trials are passed in. */
export interface SummaryTrial {
  configId: string;
  taskId: string;
  passed: boolean | null;
  costUsd: number | null;
  latencyMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface SummaryConfig {
  config_id: string;
  name: string;
  harness_id: string;
  model_id: string;
  memory_mode: string | null;
  trials_done: number;
  /** Macro: the mean over tasks of the per-task pass rate of the scored done trials. Null with no scored trial. */
  pass_rate: number | null;
  mean_cost_usd: number | null;
  mean_latency_ms: number | null;
  mean_input_tokens: number | null;
  mean_output_tokens: number | null;
}

export interface SummaryComparison {
  comparison_run_id: string;
  experiment_id: string;
  experiment_name: string;
  axis: string | null;
  config_a_id: string;
  config_a_name: string;
  config_b_id: string;
  config_b_name: string;
  verdict: AggregateBlock['verdict'];
  delta: number | null;
  ci_low: number | null;
  ci_high: number | null;
  reliability: ComparePayload['reliability'];
  judge_policy_applied: ComparePayload['judge_policy_applied'];
  stats_version: string;
  computed_at: string;
}

export interface SummaryExperiment {
  id: string;
  name: string;
  status: string;
  /** Trials per (config, task) cell, as GET /experiments reports it. */
  n_trials: number;
  progress: { pending: number; running: number; done: number; errored: number; cancelled: number; total: number };
  created_at: string;
}

/** Every category in the order of the rules, plus `uncategorized` only when a failed trial has no category yet. */
export type SummaryFailures = Partial<Record<FailureCategory | 'uncategorized', number>>;

export interface SummaryPayload {
  totals: {
    experiments: number;
    configs: number;
    tasks_current: number;
    trials_done: number;
    trials_errored: number;
    spend_usd: number;
    models: number;
    harnesses: number;
  };
  latest_comparisons: SummaryComparison[];
  configs: SummaryConfig[];
  failures: SummaryFailures;
  recent_experiments: SummaryExperiment[];
}

const mean = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;

/**
 * DESIGN 9.1 macro average: group by task, mean of the non-null values per task, then the mean of those per-task means.
 * A task with no value is left out (as compare.ts leaves out a task with no scored trial). Null when no task has a value.
 */
export function macroMean(trials: readonly SummaryTrial[], pick: (t: SummaryTrial) => number | null): number | null {
  const byTask = new Map<string, number[]>();
  for (const t of trials) {
    const v = pick(t);
    if (v === null) continue;
    const vs = byTask.get(t.taskId) ?? [];
    vs.push(v);
    byTask.set(t.taskId, vs);
  }
  if (byTask.size === 0) return null;
  return mean([...byTask.values()].map(mean));
}

/** A trial with no verdict (passed null) is unscored, exactly as in compare.ts. */
export const passOutcome = (t: SummaryTrial): number | null => (t.passed === null ? null : t.passed ? 1 : 0);

export function configRow(
  c: { id: string; name: string; harnessId: string; modelId: string; settings: unknown },
  done: readonly SummaryTrial[],
): SummaryConfig {
  const memory = (c.settings as { memory?: { mode?: unknown } } | null)?.memory?.mode;
  return {
    config_id: c.id,
    name: c.name,
    harness_id: c.harnessId,
    model_id: c.modelId,
    memory_mode: typeof memory === 'string' ? memory : null,
    trials_done: done.length,
    pass_rate: macroMean(done, passOutcome),
    mean_cost_usd: macroMean(done, (t) => t.costUsd),
    mean_latency_ms: macroMean(done, (t) => t.latencyMs),
    mean_input_tokens: macroMean(done, (t) => t.inputTokens),
    mean_output_tokens: macroMean(done, (t) => t.outputTokens),
  };
}

export function failureCounts(rows: ReadonlyArray<{ failureCategory: FailureCategory | null; count: number }>): SummaryFailures {
  const out: SummaryFailures = Object.fromEntries(FAILURE_CATEGORIES.map((c) => [c, 0]));
  let uncategorized = 0;
  for (const r of rows) {
    if (r.failureCategory === null) uncategorized += r.count;
    else out[r.failureCategory] = (out[r.failureCategory] ?? 0) + r.count;
  }
  if (uncategorized > 0) out.uncategorized = uncategorized;
  return out;
}

interface RunKey {
  id: string;
  experimentId: string;
  configAId: string;
  configBId: string;
}

/**
 * The newest run of each (experiment, A, B) pair, newest first, at most `limit`. Older runs of the same pair are earlier
 * snapshots of the same comparison; showing them would put a stale verdict next to the current one. `runs` must be sorted
 * newest first.
 */
export function newestPerPair<T extends RunKey>(runs: readonly T[], limit: number): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const r of runs) {
    const key = `${r.experimentId}|${r.configAId}|${r.configBId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
    if (out.length === limit) break;
  }
  return out;
}

const toNumber = (d: { toNumber(): number } | null): number | null => (d === null ? null : d.toNumber());

@Injectable()
export class SummaryService {
  constructor(private readonly prisma: PrismaService) {}

  /** Read in 1 RepeatableRead snapshot (SNAPSHOT_TX, as Compare) so the totals, the config rows and the histogram describe the same state. */
  async summary(): Promise<SummaryPayload> {
    return this.prisma.$transaction(
      async (tx) => {
        const [experiments, configs, tasksCurrent, trialsDone, trialsErrored, spend, models, harnessIds] = await Promise.all([
          tx.experiment.count(),
          tx.config.count(),
          tx.task.count({ where: { isCurrent: true } }),
          tx.trial.count({ where: { status: 'done' } }),
          tx.trial.count({ where: { status: 'errored' } }),
          tx.trial.aggregate({ where: { status: 'done' }, _sum: { costUsd: true } }),
          tx.model.count(),
          tx.harness.findMany({ select: { id: true }, distinct: ['id'] }),
        ]);

        const configRows = await tx.config.findMany({ orderBy: [{ name: 'asc' }, { id: 'asc' }] });
        const doneTrials = await tx.trial.findMany({
          where: { status: 'done' },
          select: { configId: true, taskId: true, passed: true, costUsd: true, latencyMs: true, inputTokens: true, outputTokens: true },
        });
        const byConfig = new Map<string, SummaryTrial[]>();
        for (const t of doneTrials) {
          const list = byConfig.get(t.configId) ?? [];
          list.push({ ...t, costUsd: toNumber(t.costUsd) });
          byConfig.set(t.configId, list);
        }

        const failed = await tx.trial.groupBy({ by: ['failureCategory'], where: { status: 'done', passed: false }, _count: { _all: true } });

        const runKeys = await tx.comparisonRun.findMany({
          select: { id: true, experimentId: true, configAId: true, configBId: true },
          orderBy: [{ computedAt: 'desc' }, { id: 'desc' }],
        });
        const picked = newestPerPair(runKeys, LATEST_COMPARISONS);
        const runs = await tx.comparisonRun.findMany({ where: { id: { in: picked.map((r) => r.id) } }, include: { experiment: { select: { name: true } } } });
        const runById = new Map(runs.map((r) => [r.id, r]));

        const recent = await tx.experiment.findMany({ orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: RECENT_EXPERIMENTS });
        const counts = await tx.trial.groupBy({
          by: ['experimentId', 'status'],
          where: { experimentId: { in: recent.map((e) => e.id) } },
          _count: { _all: true },
        });

        return {
          totals: {
            experiments,
            configs,
            tasks_current: tasksCurrent,
            trials_done: trialsDone,
            trials_errored: trialsErrored,
            spend_usd: toNumber(spend._sum.costUsd) ?? 0,
            models,
            harnesses: harnessIds.length,
          },
          latest_comparisons: picked.map((k) => {
            const r = runById.get(k.id)!;
            const p = r.result as unknown as ComparePayload;
            return {
              comparison_run_id: r.id,
              experiment_id: r.experimentId,
              experiment_name: r.experiment.name,
              axis: p.axis ?? null,
              config_a_id: r.configAId,
              config_a_name: p.config_a?.name ?? r.configAId,
              config_b_id: r.configBId,
              config_b_name: p.config_b?.name ?? r.configBId,
              verdict: p.aggregate.verdict,
              delta: p.aggregate.delta,
              ci_low: p.aggregate.ci_low,
              ci_high: p.aggregate.ci_high,
              reliability: p.reliability,
              judge_policy_applied: r.judgePolicyApplied,
              stats_version: r.statsVersion,
              computed_at: r.computedAt.toISOString(),
            };
          }),
          configs: configRows.map((c) => configRow(c, byConfig.get(c.id) ?? [])),
          failures: failureCounts(failed.map((f) => ({ failureCategory: f.failureCategory, count: f._count._all }))),
          recent_experiments: recent.map((e) => {
            const progress = { pending: 0, running: 0, done: 0, errored: 0, cancelled: 0, total: 0 };
            for (const c of counts) {
              if (c.experimentId !== e.id) continue;
              progress[c.status] += c._count._all;
              progress.total += c._count._all;
            }
            return { id: e.id, name: e.name, status: e.status, n_trials: e.nTrials, progress, created_at: e.createdAt.toISOString() };
          }),
        };
      },
      SNAPSHOT_TX,
    );
  }
}
