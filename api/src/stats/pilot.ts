import { STATS_VERSION } from './version';

/**
 * Pilot (DESIGN 9.7): within-task variance and projected CI half-widths, so N is chosen without looking at
 * the answer. This module never computes, stores or returns a delta or any per-config pass rate; the output
 * type below has no such field and pilot.spec.ts scans every key recursively.
 */

export interface PilotTrial {
  configId: string;
  taskId: string;
  status: string;
  passed: boolean | null;
}

export interface PilotInput {
  experimentId: string;
  nConfigs: number;
  /** `judged`: the task has an llm_judge grader; judged tasks may be excluded from the headline later (DESIGN 8.4). */
  tasks: ReadonlyArray<{ id: string; judged?: boolean }>;
  /** Trials of all configs, any status; only `done` ones with a verdict are used. */
  trials: ReadonlyArray<PilotTrial>;
  nPilot: number;
}

export interface PilotProjection {
  n: number;
  /** 1.96 * sqrt(2 * s2 / (n * T)) with the observed s2; null when there is no observed variance yet. */
  half_width_observed: number | null;
  /**
   * The same observed s2 with T minus the judged tasks: what the width becomes if the judge ends up excluded. Null when no
   * observed variance exists or no non-judged task is left.
   */
  half_width_observed_without_judged: number | null;
  /** The same with the Bernoulli worst case 0.25; null with no tasks. */
  half_width_bound: number | null;
  trials_total: number;
}

export interface PilotPayload {
  experiment_id: string;
  ready: boolean;
  reason?: string;
  /** Present only when the data is ready but no N is recommended (n_pilot is already above the cap). */
  recommendation_reason?: string;
  n_pilot: number;
  n_tasks: number;
  n_judged_tasks: number;
  n_configs: number;
  n_cells_used: number;
  within_task_variance: number | null;
  bernoulli_bound_variance: number;
  target_half_width: number;
  n_cap: number;
  /** N = 3, 5, 8 plus recommended_n when it is another value, so the output always justifies its own number. */
  projections: PilotProjection[];
  /** Null unless ready, and null when n_pilot is above n_cap. */
  recommended_n: number | null;
  /** True when even n_cap misses the target half-width; false whenever recommended_n is null. */
  capped: boolean;
  stats_version: string;
}

const BERNOULLI_BOUND = 0.25;
const TARGET_HALF_WIDTH = 0.15;
const N_CAP = 8;
const PROJECTED_N = [3, 5, 8] as const;
const Z = 1.96;

/** h(n) = 1.96 * sqrt(2 * s2 / (n * T)): the half-width of the 95 percent interval of the paired delta over T tasks. */
export function halfWidth(s2: number, n: number, nTasks: number): number {
  return Z * Math.sqrt((2 * s2) / (n * nTasks));
}

export function pilot(input: PilotInput): PilotPayload {
  const nTasks = input.tasks.length;
  const nJudged = input.tasks.filter((t) => t.judged === true).length;
  const nUnjudged = nTasks - nJudged;
  const cells = new Map<string, { done: number; passes: number }>();
  const taskIds = new Set(input.tasks.map((t) => t.id));
  for (const t of input.trials) {
    if (t.status !== 'done' || t.passed === null || !taskIds.has(t.taskId)) continue;
    const key = `${t.configId}\u0000${t.taskId}`;
    const cell = cells.get(key) ?? { done: 0, passes: 0 };
    cell.done++;
    if (t.passed) cell.passes++;
    cells.set(key, cell);
  }

  // Unbiased within-cell variance of a Bernoulli outcome: p(1 - p) * n / (n - 1); needs >= 2 trials.
  const variances: number[] = [];
  for (const { done, passes } of cells.values()) {
    if (done < 2) continue;
    const p = passes / done;
    variances.push((p * (1 - p) * done) / (done - 1));
  }
  const nCellsUsed = variances.length;
  const nCellsExpected = nTasks * input.nConfigs;
  const s2 = nCellsUsed > 0 ? variances.reduce((a, b) => a + b, 0) / nCellsUsed : null;

  let ready = true;
  let reason: string | undefined;
  if (nTasks === 0 || input.nConfigs < 1) {
    ready = false;
    reason = 'the experiment has no tasks or no configs';
  } else if (nCellsUsed === 0) {
    ready = false;
    reason = 'no (task, config) cell has 2 or more done trials yet, so the within-task variance is not defined';
  } else if (nCellsUsed < nCellsExpected) {
    ready = false;
    reason = `${nCellsExpected - nCellsUsed} of ${nCellsExpected} (task, config) cells have fewer than 2 done trials`;
  }

  // The recommendation exists only for a ready pilot: from a handful of cells it would be a made-up N. Above the cap
  // there is nothing to recommend (the pilot already used more than the largest N this tool projects).
  let recommendedN: number | null = null;
  let capped = false;
  let recommendationReason: string | undefined;
  if (ready && s2 !== null) {
    if (input.nPilot > N_CAP) {
      recommendationReason = `n_pilot ${input.nPilot} is above the cap of ${N_CAP}; no larger N is projected`;
    } else {
      for (let n = input.nPilot; n <= N_CAP; n++) {
        if (halfWidth(s2, n, nTasks) <= TARGET_HALF_WIDTH) {
          recommendedN = n;
          break;
        }
      }
      if (recommendedN === null) {
        recommendedN = N_CAP;
        capped = true; // the loop ran to N_CAP without meeting the target
      }
    }
  }

  const projectedNs = [...new Set<number>([...PROJECTED_N, ...(recommendedN === null ? [] : [recommendedN])])].sort((a, b) => a - b);
  const projections: PilotProjection[] = projectedNs.map((n) => ({
    n,
    half_width_observed: s2 !== null && nTasks > 0 ? halfWidth(s2, n, nTasks) : null,
    half_width_observed_without_judged: s2 !== null && nUnjudged > 0 ? halfWidth(s2, n, nUnjudged) : null,
    half_width_bound: nTasks > 0 ? halfWidth(BERNOULLI_BOUND, n, nTasks) : null,
    trials_total: n * nTasks * input.nConfigs,
  }));

  return {
    experiment_id: input.experimentId,
    ready,
    ...(reason === undefined ? {} : { reason }),
    ...(recommendationReason === undefined ? {} : { recommendation_reason: recommendationReason }),
    n_pilot: input.nPilot,
    n_tasks: nTasks,
    n_judged_tasks: nJudged,
    n_configs: input.nConfigs,
    n_cells_used: nCellsUsed,
    within_task_variance: s2,
    bernoulli_bound_variance: BERNOULLI_BOUND,
    target_half_width: TARGET_HALF_WIDTH,
    n_cap: N_CAP,
    projections,
    recommended_n: recommendedN,
    capped,
    stats_version: STATS_VERSION,
  };
}
