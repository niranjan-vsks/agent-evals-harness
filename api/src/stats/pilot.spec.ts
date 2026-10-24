import { pilot, PilotInput, PilotTrial } from './pilot';
import { STATS_VERSION } from './version';

const FORBIDDEN = /^(delta|rate_a|rate_b|p_a|p_b)$|rate|pass_rate|delta/i;

/** Every key at every depth, arrays included. */
function allKeys(x: unknown, out: string[] = []): string[] {
  if (Array.isArray(x)) x.forEach((v) => allKeys(v, out));
  else if (x !== null && typeof x === 'object') {
    for (const [k, v] of Object.entries(x)) {
      out.push(k);
      allKeys(v, out);
    }
  }
  return out;
}

const done = (configId: string, taskId: string, passes: number, total: number): PilotTrial[] =>
  Array.from({ length: total }, (_, i) => ({ configId, taskId, status: 'done', passed: i < passes }));

function grid(nTasks: number, cell: (cfg: string, task: string) => PilotTrial[], configs = ['c1', 'c2']) {
  const tasks = Array.from({ length: nTasks }, (_, i) => ({ id: `t${i + 1}` }));
  const trials = tasks.flatMap((t) => configs.flatMap((c) => cell(c, t.id)));
  return { tasks, trials };
}

describe('pilot', () => {
  it('computes s2 by hand: cells (p, n) = (0.5, 4), (1, 4), (0.25, 4), (0.75, 4) give (1/3 + 0 + 1/4 + 1/4) / 4', () => {
    const passes: Record<string, number> = { 'c1|t1': 2, 'c1|t2': 4, 'c2|t1': 1, 'c2|t2': 3 };
    const { tasks, trials } = grid(2, (c, t) => done(c, t, passes[`${c}|${t}`], 4));
    const out = pilot({ experimentId: 'e1', nConfigs: 2, tasks, trials, nPilot: 4 });
    expect(out.within_task_variance).toBeCloseTo((1 / 3 + 0 + 0.25 + 0.25) / 4, 12);
    expect(out.n_cells_used).toBe(4);
    expect(out.ready).toBe(true);
    expect(out.reason).toBeUndefined();
    // T = 2: h(n) = 1.96 * sqrt(s2 / n)
    const s2 = (1 / 3 + 0.5) / 4;
    expect(out.projections.map((p) => p.n)).toEqual([3, 5, 8]);
    expect(out.projections[0].half_width_observed).toBeCloseTo(1.96 * Math.sqrt(s2 / 3), 12);
    expect(out.projections[2].half_width_observed).toBeCloseTo(1.96 * Math.sqrt(s2 / 8), 12);
    expect(out.projections[1].trials_total).toBe(5 * 2 * 2);
    // 0.316 at n = 8 still misses 0.15: the cap applies
    expect(out.recommended_n).toBe(8);
    expect(out.capped).toBe(true);
  });

  it('matches DESIGN 9.7 for the bound: T = 22 gives 0.171, 0.132, 0.104 at N = 3, 5, 8', () => {
    const { tasks, trials } = grid(22, (c, t) => done(c, t, 2, 4));
    const out = pilot({ experimentId: 'e1', nConfigs: 2, tasks, trials, nPilot: 3 });
    const designRows = out.projections.filter((p) => [3, 5, 8].includes(p.n));
    expect(designRows.map((p) => p.half_width_bound)).toEqual([
      expect.closeTo(0.1707, 3),
      expect.closeTo(0.1322, 3),
      expect.closeTo(0.1045, 3),
    ]);
    expect(out.bernoulli_bound_variance).toBe(0.25);
    expect(out.target_half_width).toBe(0.15);
    expect(out.n_cap).toBe(8);
    expect(designRows.map((p) => p.trials_total)).toEqual([132, 220, 352]);
  });

  it('recommends the smallest n >= nPilot with observed h <= 0.15 (T = 22, s2 = 1/3: n = 5 gives 0.1526, n = 6 gives 0.1393)', () => {
    const { tasks, trials } = grid(22, (c, t) => done(c, t, 2, 4));
    const base: PilotInput = { experimentId: 'e1', nConfigs: 2, tasks, trials, nPilot: 3 };
    const out = pilot(base);
    expect(out.within_task_variance).toBeCloseTo(1 / 3, 12);
    expect(out.projections[1].half_width_observed).toBeCloseTo(0.1526, 3);
    expect(out.recommended_n).toBe(6);
    expect(out.capped).toBe(false);
    // the recommended N has its own projection row, so the output justifies its number: 6 meets 0.15, 5 does not
    expect(out.projections.map((p) => p.n)).toEqual([3, 5, 6, 8]);
    const row6 = out.projections.find((p) => p.n === 6)!;
    expect(row6.half_width_observed).toBeCloseTo(0.1393, 3);
    expect(row6.half_width_observed!).toBeLessThanOrEqual(0.15);
    expect(row6.trials_total).toBe(6 * 22 * 2);
    expect(out.projections.find((p) => p.n === 5)!.half_width_observed!).toBeGreaterThan(0.15);
    const seven = pilot({ ...base, nPilot: 7 });
    expect(seven.recommended_n).toBe(7);
    expect(seven.projections.map((p) => p.n)).toEqual([3, 5, 7, 8]);
  });

  it('does not duplicate a projection row when the recommendation is already 3, 5 or 8', () => {
    const { tasks, trials } = grid(22, (c, t) => done(c, t, 3, 3));
    expect(pilot({ experimentId: 'e1', nConfigs: 2, tasks, trials, nPilot: 3 }).projections.map((p) => p.n)).toEqual([3, 5, 8]);
  });

  it('recommends nPilot itself when it already meets the target, and handles zero variance', () => {
    const { tasks, trials } = grid(22, (c, t) => done(c, t, 3, 3));
    const out = pilot({ experimentId: 'e1', nConfigs: 2, tasks, trials, nPilot: 3 });
    expect(out.within_task_variance).toBe(0);
    expect(out.projections.every((p) => p.half_width_observed === 0)).toBe(true);
    expect(out.recommended_n).toBe(3);
    expect(out.capped).toBe(false);
  });

  it('uses only done trials with a verdict, only cells with >= 2 of them', () => {
    const { tasks, trials } = grid(1, (c) => [
      ...done(c, 't1', 1, 2), // p = 0.5, n = 2: 0.25 * 2 / 1 = 0.5
      { configId: c, taskId: 't1', status: 'errored', passed: null },
      { configId: c, taskId: 't1', status: 'cancelled', passed: false },
      { configId: c, taskId: 't1', status: 'pending', passed: null },
      { configId: c, taskId: 't1', status: 'done', passed: null },
    ]);
    const out = pilot({ experimentId: 'e1', nConfigs: 2, tasks, trials, nPilot: 2 });
    expect(out.within_task_variance).toBeCloseTo(0.5, 12);
    expect(out.n_cells_used).toBe(2);
  });

  it('is not ready, with a reason, when cells lack 2 done trials, and still reports what it can', () => {
    const { tasks, trials } = grid(2, (c, t) => (t === 't1' ? done(c, t, 1, 2) : done(c, t, 1, 1)));
    const out = pilot({ experimentId: 'e1', nConfigs: 2, tasks, trials, nPilot: 3 });
    expect(out.ready).toBe(false);
    expect(out.reason).toContain('2 of 4');
    expect(out.n_cells_used).toBe(2);
    expect(out.within_task_variance).toBeCloseTo(0.5, 12);
    // from 2 of 4 cells there is no N to recommend
    expect(out.recommended_n).toBeNull();
    expect(out.capped).toBe(false);
    expect(out.projections.map((p) => p.n)).toEqual([3, 5, 8]);
  });

  it('1 usable cell out of 44 gives no recommendation and capped false (not a made-up 8)', () => {
    const { tasks } = grid(22, () => []);
    const trials = done('c1', 't1', 1, 2);
    for (const nPilot of [3, 10]) {
      const out = pilot({ experimentId: 'e1', nConfigs: 2, tasks, trials, nPilot });
      expect(out).toMatchObject({ ready: false, n_cells_used: 1, recommended_n: null, capped: false });
      expect(out.within_task_variance).toBeCloseTo(0.5, 12);
    }
  });

  it('when n_pilot is above the cap the recommendation is null with a reason, not 8 and not capped', () => {
    const { tasks, trials } = grid(22, (c, t) => done(c, t, 5, 10));
    const out = pilot({ experimentId: 'e1', nConfigs: 2, tasks, trials, nPilot: 10 });
    expect(out.ready).toBe(true);
    expect(out.reason).toBeUndefined();
    expect(out.recommended_n).toBeNull();
    expect(out.capped).toBe(false);
    expect(out.recommendation_reason).toContain('above the cap of 8');
    expect(out.projections.map((p) => p.n)).toEqual([3, 5, 8]);
    // n_pilot = 8 is still inside the cap
    const eight = pilot({ experimentId: 'e1', nConfigs: 2, tasks, trials, nPilot: 8 });
    expect(eight.recommended_n).toBe(8);
    expect(eight.recommendation_reason).toBeUndefined();
  });

  it('with no usable trials: not ready, null variance, bound still projected, no recommendation', () => {
    const out = pilot({ experimentId: 'e1', nConfigs: 2, tasks: [{ id: 't1' }, { id: 't2' }], trials: [], nPilot: 3 });
    expect(out).toMatchObject({ ready: false, n_cells_used: 0, within_task_variance: null, recommended_n: null, capped: false, stats_version: STATS_VERSION });
    expect(out.reason).toBeTruthy();
    expect(out.projections.map((p) => p.half_width_observed)).toEqual([null, null, null]);
    expect(out.projections[0].half_width_bound).toBeCloseTo(1.96 * Math.sqrt(0.5 / 6), 12);
  });

  it('with 0 tasks does not throw and projects nothing', () => {
    const out = pilot({ experimentId: 'e1', nConfigs: 2, tasks: [], trials: [], nPilot: 3 });
    expect(out.ready).toBe(false);
    expect(out.projections.every((p) => p.half_width_bound === null && p.half_width_observed === null)).toBe(true);
  });

  it('ignores trials of tasks that are not in the experiment', () => {
    const { tasks, trials } = grid(1, (c) => done(c, 't1', 1, 2));
    const stray = done('c1', 'zzz', 1, 4);
    const out = pilot({ experimentId: 'e1', nConfigs: 2, tasks, trials: [...trials, ...stray], nPilot: 2 });
    expect(out.n_cells_used).toBe(2);
  });

  it('NEVER emits a delta or a per-config pass rate: scans every key at every depth, on ready and not-ready payloads', () => {
    const { tasks, trials } = grid(22, (c, t) => done(c, t, c === 'c1' ? 3 : 1, 4));
    const payloads = [
      pilot({ experimentId: 'e1', nConfigs: 2, tasks, trials, nPilot: 3 }),
      pilot({ experimentId: 'e1', nConfigs: 2, tasks, trials: [], nPilot: 3 }),
      pilot({ experimentId: 'e1', nConfigs: 2, tasks: [], trials: [], nPilot: 3 }),
    ];
    for (const p of payloads) {
      const keys = allKeys(p);
      expect(keys.length).toBeGreaterThan(10);
      expect(keys.filter((k) => FORBIDDEN.test(k))).toEqual([]);
      for (const bad of ['delta', 'rate_a', 'rate_b', 'p_a', 'p_b']) expect(keys).not.toContain(bad);
    }
    // the payload also carries no value that could be a per-config rate: configs differ by 0.5 here and nothing shows it
    const json = JSON.stringify(payloads[0]);
    expect(json).not.toContain('"c1"');
    expect(json).not.toContain('"c2"');
  });

  it('returns exactly the documented keys', () => {
    const { tasks, trials } = grid(2, (c, t) => done(c, t, 1, 2));
    const out = pilot({ experimentId: 'e1', nConfigs: 2, tasks, trials, nPilot: 2 });
    expect(Object.keys(out).sort()).toEqual(
      [
        'experiment_id', 'ready', 'n_pilot', 'n_tasks', 'n_judged_tasks', 'n_configs', 'n_cells_used', 'within_task_variance',
        'bernoulli_bound_variance', 'target_half_width', 'n_cap', 'projections', 'recommended_n', 'capped', 'stats_version',
      ].sort(),
    );
    expect(Object.keys(out.projections[0]).sort()).toEqual([
      'half_width_bound',
      'half_width_observed',
      'half_width_observed_without_judged',
      'n',
      'trials_total',
    ]);
  });

  describe('judged tasks', () => {
    // 4 tasks, 1 judged; every cell has p = 0.5 over 4 trials so s2 = 1/3
    const judgedGrid = (judgedIds: string[]) => {
      const { tasks, trials } = grid(4, (c, t) => done(c, t, 2, 4));
      return { tasks: tasks.map((t) => ({ ...t, judged: judgedIds.includes(t.id) })), trials };
    };

    it('counts the judged tasks and projects the width with T minus the judged tasks, using the same s2', () => {
      const { tasks, trials } = judgedGrid(['t1']);
      const out = pilot({ experimentId: 'e1', nConfigs: 2, tasks, trials, nPilot: 3 });
      expect(out.n_judged_tasks).toBe(1);
      expect(out.n_tasks).toBe(4);
      expect(out.within_task_variance).toBeCloseTo(1 / 3, 12);
      const p3 = out.projections.find((p) => p.n === 3)!;
      expect(p3.half_width_observed).toBeCloseTo(1.96 * Math.sqrt((2 / 3) / (3 * 4)), 12);
      expect(p3.half_width_observed_without_judged).toBeCloseTo(1.96 * Math.sqrt((2 / 3) / (3 * 3)), 12);
      expect(p3.half_width_observed_without_judged!).toBeGreaterThan(p3.half_width_observed!);
    });

    it('without any judged task the two widths are equal; the flag defaults to false', () => {
      const { tasks, trials } = grid(4, (c, t) => done(c, t, 2, 4));
      const out = pilot({ experimentId: 'e1', nConfigs: 2, tasks, trials, nPilot: 3 });
      expect(out.n_judged_tasks).toBe(0);
      for (const p of out.projections) expect(p.half_width_observed_without_judged).toBe(p.half_width_observed);
    });

    it('is null when every task is judged, or when there is no observed variance', () => {
      const all = judgedGrid(['t1', 't2', 't3', 't4']);
      const out = pilot({ experimentId: 'e1', nConfigs: 2, tasks: all.tasks, trials: all.trials, nPilot: 3 });
      expect(out.n_judged_tasks).toBe(4);
      expect(out.projections.every((p) => p.half_width_observed_without_judged === null)).toBe(true);
      expect(out.projections.every((p) => p.half_width_observed !== null)).toBe(true);
      const none = pilot({ experimentId: 'e1', nConfigs: 2, tasks: [{ id: 't1', judged: false }], trials: [], nPilot: 3 });
      expect(none.projections.every((p) => p.half_width_observed_without_judged === null)).toBe(true);
    });

    it('still has no delta or rate key with judged tasks', () => {
      const { tasks, trials } = judgedGrid(['t1', 't2']);
      const keys = allKeys(pilot({ experimentId: 'e1', nConfigs: 2, tasks, trials, nPilot: 3 }));
      expect(keys).toContain('half_width_observed_without_judged');
      expect(keys.filter((k) => FORBIDDEN.test(k))).toEqual([]);
    });
  });
});
