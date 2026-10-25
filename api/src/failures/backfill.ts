/**
 * `npm run failures:backfill`: recomputes the failure category of every `done, passed = false` trial from its stored trace, grader
 * results and judge labels, and prints a histogram per experiment and config. New trials are categorized at ingest; this covers the
 * trials stored before 0003_failure_category and the ones whose judge labels arrived after ingest (rule 8 needs a label, and a label
 * can only exist once the trial does). The rules are pure, so running it again changes nothing unless the rules or the labels did.
 *
 * It only writes `failure_category` and `failure_evidence` of done, failed trials. It takes no experiment lock and no trial lock
 * beyond the row it updates, so it can run while an experiment is running (a running experiment settles other rows).
 */
import { canonicalJson } from '../common/canonical-json';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { Categorized, categorize, FAILURE_CATEGORIES, FailureCategory, FailureGrader } from './rules';

export interface BackfillOptions {
  experimentId?: string;
  /** Compute and report; write nothing. */
  dryRun?: boolean;
  /** Per category, this many trials are drawn at random (seeded) for a person to read against the evidence. 0 = none. */
  sample?: number;
  seed?: number;
  /** Trials loaded per query; each carries a whole trace. */
  pageSize?: number;
}

export interface SampleRow {
  trialId: string;
  taskId: string;
  configName: string;
  category: FailureCategory;
  detail: string;
  eventSeq: number | null;
  graderIndex: number | null;
  exitReason: string | null;
  finalResponse: string;
}

export interface HistogramRow {
  experimentId: string;
  configId: string;
  configName: string;
  total: number;
  counts: Record<FailureCategory, number>;
}

export interface BackfillReport {
  examined: number;
  updated: number;
  unchanged: number;
  histogram: HistogramRow[];
  totals: Record<FailureCategory, number>;
  /** share of all failures that landed in wrong_answer (card section 9: more than 0.5 is a stop condition) */
  wrongAnswerShare: number | null;
  samples: Record<FailureCategory, SampleRow[]>;
  /** true when the CHECK "category iff done and failed" is now validated for every row */
  constraintValidated: boolean;
  dryRun: boolean;
}

const zero = (): Record<FailureCategory, number> => Object.fromEntries(FAILURE_CATEGORIES.map((c) => [c, 0])) as Record<FailureCategory, number>;

/** mulberry32, the generator the statistics use (api/src/stats/bootstrap.ts), so a sample is reproducible from its seed. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** jsonb stores object keys in its own order, so the stored evidence is compared with the new one by value, not by text. */
const sameEvidence = (a: unknown, b: unknown) => canonicalJson(a ?? null) === canonicalJson(b);

export async function backfill(prisma: PrismaService, opts: BackfillOptions = {}): Promise<BackfillReport> {
  const pageSize = opts.pageSize ?? 50;
  const where: Prisma.TrialWhereInput = { status: 'done', passed: false, ...(opts.experimentId ? { experimentId: opts.experimentId } : {}) };
  const histogram = new Map<string, HistogramRow>();
  const totals = zero();
  const pool: Record<FailureCategory, SampleRow[]> = Object.fromEntries(FAILURE_CATEGORIES.map((c) => [c, [] as SampleRow[]])) as never;
  let examined = 0;
  let updated = 0;
  let cursor: string | undefined;

  for (;;) {
    const page = await prisma.trial.findMany({
      where,
      orderBy: { id: 'asc' },
      take: pageSize,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      include: {
        config: { select: { name: true, settings: true } },
        task: { select: { category: true, fixtureDir: true } },
        trace: true,
        graders: { orderBy: { graderIndex: 'asc' }, include: { judgeLabels: true } },
      },
    });
    if (page.length === 0) break;
    cursor = page[page.length - 1].id;

    for (const t of page) {
      examined++;
      const settings = t.config.settings as { memory?: { mode?: string } } | null;
      const graders: FailureGrader[] = t.graders.map((g) => ({
        grader_index: g.graderIndex,
        grader_type: g.graderType,
        passed: g.passed,
        details: (g.details ?? {}) as Record<string, unknown>,
      }));
      const labels = t.graders.flatMap((g) => g.judgeLabels.map((l) => ({ graderIndex: l.graderIndex, humanPassed: l.humanPassed })));
      const events = Array.isArray(t.trace?.events) ? (t.trace!.events as unknown as Parameters<typeof categorize>[1]['events']) : [];
      const found: Categorized = categorize(
        {
          // A done trial always has an exit_reason (CHECK trial_exit_reason_iff_done).
          exitReason: t.exitReason!,
          steps: t.steps,
          taskCategory: t.task.category,
          taskFixtureDir: t.task.fixtureDir,
          memoryMode: settings?.memory?.mode === 'seeded' ? 'seeded' : 'off',
        },
        { events, finalResponse: t.trace?.finalResponse ?? null, memoryInitial: (t.trace?.memoryInitial ?? {}) as Record<string, string> },
        graders,
        labels,
      );

      const changed = t.failureCategory !== found.category || !sameEvidence(t.failureEvidence, found.evidence);
      if (changed && !opts.dryRun) {
        const n = await prisma.trial.updateMany({
          where: { id: t.id, status: 'done', passed: false },
          data: { failureCategory: found.category, failureEvidence: found.evidence as unknown as Prisma.InputJsonValue },
        });
        if (n.count > 0) updated++;
      } else if (changed) {
        updated++; // would be updated
      }

      totals[found.category]++;
      const key = `${t.experimentId}|${t.configId}`;
      const row = histogram.get(key) ?? { experimentId: t.experimentId, configId: t.configId, configName: t.config.name, total: 0, counts: zero() };
      row.total++;
      row.counts[found.category]++;
      histogram.set(key, row);
      if (opts.sample) {
        pool[found.category].push({
          trialId: t.id,
          taskId: t.taskId,
          configName: t.config.name,
          category: found.category,
          detail: found.evidence.detail,
          eventSeq: found.evidence.event_seq ?? null,
          graderIndex: found.evidence.grader_index ?? null,
          exitReason: t.exitReason,
          finalResponse: (t.trace?.finalResponse ?? '').slice(0, 200),
        });
      }
    }
  }

  const samples = Object.fromEntries(FAILURE_CATEGORIES.map((c) => [c, [] as SampleRow[]])) as Record<FailureCategory, SampleRow[]>;
  if (opts.sample) {
    const next = rng(opts.seed ?? 20261025);
    for (const c of FAILURE_CATEGORIES) {
      const rows = [...pool[c]];
      for (let i = rows.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [rows[i], rows[j]] = [rows[j], rows[i]];
      }
      samples[c] = rows.slice(0, opts.sample);
    }
  }

  let constraintValidated = false;
  if (!opts.dryRun) constraintValidated = await validateConstraint(prisma);

  return {
    examined,
    updated,
    unchanged: examined - updated,
    histogram: [...histogram.values()].sort((x, y) => x.experimentId.localeCompare(y.experimentId) || x.configName.localeCompare(y.configName)),
    totals,
    wrongAnswerShare: examined === 0 ? null : totals.wrong_answer / examined,
    samples,
    constraintValidated,
    dryRun: !!opts.dryRun,
  };
}

/**
 * 0003_failure_category adds the CHECK NOT VALID when old rows exist. Once none of them lacks a category (this run filled them, or
 * it ran with the experiment filter and the rest was already done) the constraint is validated for good. Returns whether it is.
 */
export async function validateConstraint(prisma: PrismaService): Promise<boolean> {
  const missing = await prisma.trial.count({ where: { status: 'done', passed: false, failureCategory: null } });
  if (missing > 0) return false;
  await prisma.$executeRawUnsafe('ALTER TABLE "trial" VALIDATE CONSTRAINT trial_failure_category_iff_failed');
  return true;
}

export function formatReport(r: BackfillReport): string {
  const out: string[] = [];
  out.push(`failures:backfill${r.dryRun ? ' (dry run, nothing written)' : ''}: ${r.examined} failed trial(s) examined, ${r.updated} ${r.dryRun ? 'would change' : 'updated'}, ${r.unchanged} unchanged`);
  const cols = FAILURE_CATEGORIES;
  const rows = r.histogram.map((h) => ({ label: `${h.experimentId}  ${h.configName}`, total: h.total, counts: h.counts }));
  const width = Math.max(12, ...rows.map((x) => x.label.length));
  out.push('');
  out.push(`${'experiment  config'.padEnd(width)}  ${'failed'.padStart(6)}  ${cols.join('  ')}`);
  for (const x of rows) out.push(`${x.label.padEnd(width)}  ${String(x.total).padStart(6)}  ${cols.map((c) => String(x.counts[c]).padStart(c.length)).join('  ')}`);
  out.push(`${'all'.padEnd(width)}  ${String(r.examined).padStart(6)}  ${cols.map((c) => String(r.totals[c]).padStart(c.length)).join('  ')}`);
  if (r.wrongAnswerShare !== null) {
    out.push('');
    out.push(`wrong_answer is ${(r.wrongAnswerShare * 100).toFixed(1)} percent of the failures`);
    if (r.wrongAnswerShare > 0.5) out.push('STOP CONDITION (card section 9): more than 50 percent of the failures are wrong_answer; report this histogram, do not add rules without an architect decision');
  }
  if (!r.dryRun) out.push(r.constraintValidated ? 'constraint trial_failure_category_iff_failed is validated for every row' : 'constraint trial_failure_category_iff_failed is still NOT VALID: some failed trial has no category (run again without --experiment)');
  for (const c of FAILURE_CATEGORIES) {
    if (r.samples[c].length === 0) continue;
    out.push('');
    out.push(`sample of ${c}:`);
    for (const s of r.samples[c]) {
      const at = [s.eventSeq !== null ? `event ${s.eventSeq}` : null, s.graderIndex !== null ? `grader ${s.graderIndex}` : null].filter(Boolean).join(', ');
      out.push(`  ${s.trialId}  ${s.taskId}  exit ${s.exitReason}  ${at ? `[${at}]  ` : ''}${s.detail}`);
      out.push(`      final: ${JSON.stringify(s.finalResponse)}`);
    }
  }
  return out.join('\n');
}
