/**
 * `npm run judge:sample -- --n 30` (DESIGN 8.2 step 2): draws judge-graded trials for a human to label,
 * stratified by (task, config), and writes experiments/judge-validation/sample.jsonl.
 *
 * The file is blind (D-15). A line is built from an explicit list of fields, so the judge's verdict
 * (`passed`, the per-criterion `met` and `evidence`, `reasoning`) and the config the trial ran under
 * cannot reach it by accident: there is no code path from those columns to a line.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { PrismaService } from '../prisma/prisma.service';
import { compareCodePoints } from '../common/canonical-json';
import { mulberry32 } from '../stats/bootstrap';

export interface Candidate {
  trialId: string;
  graderIndex: number;
  taskId: string;
  configId: string;
  taskPrompt: string;
  rubric: { id: string; criterion: string }[];
  inputs: { name: string; text: string }[];
}

/** What a labeler sees, and nothing else. */
export interface SampleLine {
  trial_id: string;
  grader_index: number;
  task_id: string;
  task_prompt: string;
  rubric: { id: string; criterion: string }[];
  inputs: { name: string; text: string }[];
}

export function toBlindLine(c: Candidate): SampleLine {
  return {
    trial_id: c.trialId,
    grader_index: c.graderIndex,
    task_id: c.taskId,
    task_prompt: c.taskPrompt,
    rubric: c.rubric.map(({ id, criterion }) => ({ id, criterion })),
    inputs: c.inputs.map(({ name, text }) => ({ name, text })),
  };
}

function shuffle<T>(xs: T[], rng: () => number): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export interface Draw {
  chosen: Candidate[];
  /** Items drawn per (task, config) cell. */
  perCell: Record<string, number>;
  /** True when fewer than n candidates exist. */
  short: boolean;
}

/**
 * Round robin over the (task, config) cells, taking 1 item from a cell per turn, until n are drawn or
 * every cell is empty. With 5 judge tasks and 2 configs, n = 30 gives 3 per cell and 6 per task
 * (DESIGN 8.2). The cell order, the order within a cell and the order of the output are shuffled with
 * the seed, so a small n is not biased toward the first task ids and the file order carries no
 * information about the config. Same candidates and seed give the same file.
 */
export function stratifiedDraw(candidates: Candidate[], n: number, seed: number): Draw {
  const rng = mulberry32(seed);
  const cells = new Map<string, Candidate[]>();
  for (const c of [...candidates].sort((a, b) => compareCodePoints(a.trialId, b.trialId) || a.graderIndex - b.graderIndex)) {
    const key = `${c.taskId}|${c.configId}`;
    cells.set(key, [...(cells.get(key) ?? []), c]);
  }
  const keys = shuffle([...cells.keys()].sort(), rng);
  const queues = new Map(keys.map((k) => [k, shuffle(cells.get(k)!, rng)]));
  const chosen: Candidate[] = [];
  const perCell: Record<string, number> = {};
  while (chosen.length < n && [...queues.values()].some((q) => q.length > 0)) {
    for (const key of keys) {
      const next = queues.get(key)!.shift();
      if (next === undefined) continue;
      chosen.push(next);
      perCell[key] = (perCell[key] ?? 0) + 1;
      if (chosen.length === n) break;
    }
  }
  return { chosen: shuffle(chosen, rng), perCell, short: chosen.length < n };
}

export async function loadCandidates(
  prisma: PrismaService,
  opts: { experimentId?: string; includeAdhoc?: boolean } = {},
): Promise<{ candidates: Candidate[]; skipped: number }> {
  // Ad hoc trials are single hand runs, not the pilot or full run the protocol samples (DESIGN 8.2); they are drawn only on request.
  const experiment = opts.experimentId ? { id: opts.experimentId } : opts.includeAdhoc ? {} : { NOT: { name: { startsWith: 'adhoc-' } } };
  const rows = await prisma.graderResult.findMany({
    where: { graderType: 'llm_judge', trial: { status: 'done', experiment } },
    include: { trial: { include: { task: true } } },
    orderBy: [{ trialId: 'asc' }, { graderIndex: 'asc' }],
  });
  const candidates: Candidate[] = [];
  let skipped = 0;
  for (const r of rows) {
    const details = r.details as { judged_inputs?: { name: string; text: string }[] } | null;
    const graders = r.trial.task.graders as { rubric?: { id: string; criterion: string }[] }[];
    const rubric = graders[r.graderIndex]?.rubric;
    if (!details?.judged_inputs || !rubric) {
      skipped++; // a result from before the judge kept its inputs: a human cannot see what it saw
      continue;
    }
    candidates.push({
      trialId: r.trialId,
      graderIndex: r.graderIndex,
      taskId: r.trial.taskId,
      configId: r.trial.configId,
      taskPrompt: r.trial.task.prompt,
      rubric,
      inputs: details.judged_inputs,
    });
  }
  return { candidates, skipped };
}

export function writeSample(path: string, chosen: Candidate[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, chosen.map((c) => JSON.stringify(toBlindLine(c)) + '\n').join(''), 'utf8');
}
