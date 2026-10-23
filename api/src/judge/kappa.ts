/**
 * `npm run judge:kappa` (DESIGN 8.2 step 4, 8.3): joins the human labels to the judge's verdicts,
 * computes raw agreement, Cohen's kappa and a 95 percent bootstrap interval over items, stores
 * the labels (judge_label) and writes a judge_validation row whose policy follows DESIGN 8.3.
 */
import { createHash } from 'node:crypto';
import { Prisma } from '../generated/prisma/client';
import { ulid } from '../common/ulid';
import { canonicalJson, compareCodePoints } from '../common/canonical-json';
import { PrismaService } from '../prisma/prisma.service';
import { percentileBootstrap } from '../stats/bootstrap';
import { cohenKappa } from '../stats/kappa';
import { JudgePolicy, judgePolicy, round4 } from './policy';

export const KAPPA_RESAMPLES = 10_000;
/** DESIGN 8.2 labels 30 items. A smaller set still gets numbers, but not a row that would become the latest validation. */
export const MIN_ITEMS = 30;
/** Fixed, so the same labels give the same interval. */
export const KAPPA_SEED = 20261023;

export interface LabelLine {
  trial_id: string;
  grader_index: number;
  human_passed: boolean;
  labeler: string;
  note?: string | null;
}

/** labels.jsonl: 1 object per line {trial_id, grader_index, human_passed, labeler, note?}. Blank lines are ignored. */
export function parseLabels(text: string): LabelLine[] {
  const out: LabelLine[] = [];
  const seen = new Set<string>();
  text.split(/\r?\n/).forEach((raw, i) => {
    if (!raw.trim()) return;
    const at = `labels line ${i + 1}`;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      throw new Error(`${at}: not valid JSON`);
    }
    if (typeof obj.trial_id !== 'string' || !obj.trial_id) throw new Error(`${at}: trial_id must be a string`);
    if (!Number.isInteger(obj.grader_index)) throw new Error(`${at}: grader_index must be an integer`);
    if (typeof obj.human_passed !== 'boolean') throw new Error(`${at}: human_passed must be true or false`);
    if (typeof obj.labeler !== 'string' || !obj.labeler) throw new Error(`${at}: labeler must be a non-empty string`);
    const key = `${obj.trial_id}|${obj.grader_index}|${obj.labeler}`;
    if (seen.has(key)) throw new Error(`${at}: ${obj.trial_id} grader ${obj.grader_index} is already labelled by ${obj.labeler}`);
    seen.add(key);
    out.push({
      trial_id: obj.trial_id,
      grader_index: obj.grader_index as number,
      human_passed: obj.human_passed,
      labeler: obj.labeler,
      note: typeof obj.note === 'string' ? obj.note : null,
    });
  });
  return out;
}

/** sha256 of the labels used, order independent (DATA_MODEL 2.12 label_set_hash). */
export function labelSetHash(labels: LabelLine[]): string {
  const rows = labels
    .map((l) => ({ trial_id: l.trial_id, grader_index: l.grader_index, human_passed: l.human_passed, labeler: l.labeler }))
    .sort((a, b) => compareCodePoints(a.trial_id, b.trial_id) || a.grader_index - b.grader_index || compareCodePoints(a.labeler, b.labeler));
  return createHash('sha256').update(canonicalJson(rows), 'utf8').digest('hex');
}

export interface Validation {
  nItems: number;
  agreementRaw: number;
  kappa: number;
  kappaCiLow: number;
  kappaCiHigh: number;
  policy: JudgePolicy;
  /** Bootstrap resamples that had a defined kappa. */
  usedResamples: number;
}

export type ValidationOutcome = { ok: true; validation: Validation } | { ok: false; reason: string };

/** pairs are [judgePassed, humanPassed]. All numbers are rounded to the 4 places the table stores, and the policy is decided on those. */
export function computeValidation(pairs: ReadonlyArray<readonly [boolean, boolean]>, opts: { minItems?: number; resamples?: number; seed?: number } = {}): ValidationOutcome {
  const { minItems = MIN_ITEMS, resamples = KAPPA_RESAMPLES, seed = KAPPA_SEED } = opts;
  if (pairs.length < Math.max(2, minItems)) {
    return { ok: false, reason: `need at least ${Math.max(2, minItems)} labelled items for a validation row (DESIGN 8.2 labels 30), have ${pairs.length}` };
  }
  const k = cohenKappa(pairs);
  if (k.kappa === null) {
    return { ok: false, reason: 'the judge and the labeler each gave every item the same label, so kappa is 0/0; the labelled set cannot validate a judge' };
  }
  const ci = percentileBootstrap(pairs, (s) => cohenKappa(s).kappa ?? NaN, resamples, seed);
  if (ci.usedResamples === 0) return { ok: false, reason: 'no bootstrap resample had a defined kappa' };
  const kappa = round4(k.kappa);
  return {
    ok: true,
    validation: {
      nItems: k.n,
      agreementRaw: round4(k.agreement),
      kappa,
      kappaCiLow: round4(ci.ciLow),
      kappaCiHigh: round4(ci.ciHigh),
      policy: judgePolicy(kappa),
      usedResamples: ci.usedResamples,
    },
  };
}

export interface KappaRun {
  judgeModelId: string;
  judgePromptHash: string;
  labeler: string;
  outcome: ValidationOutcome;
  validationId: string | null;
}

/**
 * Stores the labels and 1 judge_validation row per (judge model, judge prompt hash) found among them.
 * Throws, writing nothing, when a label does not point at an llm_judge result.
 */
export async function runKappa(prisma: PrismaService, labels: LabelLine[], opts: { labeler?: string; minItems?: number } = {}): Promise<KappaRun[]> {
  const labelers = [...new Set(labels.map((l) => l.labeler))];
  if (labelers.length === 0) throw new Error('no labels');
  if (opts.labeler && !labelers.includes(opts.labeler)) throw new Error(`no labels by ${opts.labeler}`);
  if (!opts.labeler && labelers.length > 1) {
    throw new Error(`labels by ${labelers.length} labelers (${labelers.join(', ')}): pass --labeler <name>; kappa is computed for 1 labeler at a time`);
  }
  const labeler = opts.labeler ?? labelers[0];
  const mine = labels.filter((l) => l.labeler === labeler);

  const results = await prisma.graderResult.findMany({ where: { OR: mine.map((l) => ({ trialId: l.trial_id, graderIndex: l.grader_index })) } });
  const byKey = new Map(results.map((r) => [`${r.trialId}|${r.graderIndex}`, r]));
  const problems = mine.flatMap((l) => {
    const r = byKey.get(`${l.trial_id}|${l.grader_index}`);
    if (!r) return [`${l.trial_id} grader ${l.grader_index}: no such grader result`];
    if (r.graderType !== 'llm_judge' || !r.judgeModelId || !r.judgePromptHash) return [`${l.trial_id} grader ${l.grader_index}: not an llm_judge result`];
    return [];
  });
  if (problems.length) throw new Error(`labels that do not match a judge result:\n  ${problems.join('\n  ')}`);

  const groups = new Map<string, { judgeModelId: string; judgePromptHash: string; items: { label: LabelLine; judgePassed: boolean }[] }>();
  for (const l of mine) {
    const r = byKey.get(`${l.trial_id}|${l.grader_index}`)!;
    const key = `${r.judgeModelId}|${r.judgePromptHash}`;
    const g = groups.get(key) ?? { judgeModelId: r.judgeModelId!, judgePromptHash: r.judgePromptHash!, items: [] };
    g.items.push({ label: l, judgePassed: r.passed });
    groups.set(key, g);
  }

  const runs: KappaRun[] = [];
  await prisma.$transaction(async (tx) => {
    for (const l of mine) {
      await tx.judgeLabel.upsert({
        where: { trialId_graderIndex_labeler: { trialId: l.trial_id, graderIndex: l.grader_index, labeler } },
        create: { id: ulid(), trialId: l.trial_id, graderIndex: l.grader_index, humanPassed: l.human_passed, labeler, note: l.note ?? null },
        update: { humanPassed: l.human_passed, note: l.note ?? null },
      });
    }
    for (const g of groups.values()) {
      const outcome = computeValidation(
        g.items.map((i) => [i.judgePassed, i.label.human_passed] as const),
        { minItems: opts.minItems },
      );
      let validationId: string | null = null;
      if (outcome.ok) {
        const v = outcome.validation;
        validationId = ulid();
        await tx.judgeValidation.create({
          data: {
            id: validationId,
            judgeModelId: g.judgeModelId,
            judgePromptHash: g.judgePromptHash,
            labelSetHash: labelSetHash(g.items.map((i) => i.label)),
            nItems: v.nItems,
            agreementRaw: new Prisma.Decimal(v.agreementRaw),
            kappa: new Prisma.Decimal(v.kappa),
            kappaCiLow: new Prisma.Decimal(v.kappaCiLow),
            kappaCiHigh: new Prisma.Decimal(v.kappaCiHigh),
            policy: v.policy,
          },
        });
      }
      runs.push({ judgeModelId: g.judgeModelId, judgePromptHash: g.judgePromptHash, labeler, outcome, validationId });
    }
  });
  return runs;
}
