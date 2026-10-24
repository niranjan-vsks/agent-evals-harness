import {
  assertExperimentTransition,
  assertTrialTransition,
  canCancel,
  canExperimentTransition,
  canExtend,
  canResume,
  canStart,
  canTrialTransition,
  ExperimentStatus,
  ExperimentVia,
  InvalidTransitionError,
  TrialStatus,
} from './transitions';

const EXPERIMENT: ExperimentStatus[] = ['draft', 'queued', 'running', 'completed', 'partial', 'cancelled'];
const TRIAL: TrialStatus[] = ['pending', 'running', 'done', 'errored', 'cancelled'];

describe('experiment transitions', () => {
  it.each<[ExperimentStatus, ExperimentStatus, ExperimentVia]>([
    ['draft', 'queued', 'start'],
    ['queued', 'running', 'dispatch'],
    ['draft', 'running', 'adhoc'],
    ['running', 'completed', 'derive'],
    ['running', 'partial', 'derive'],
    ['completed', 'running', 'extend'],
    ['partial', 'running', 'extend'],
    ['draft', 'cancelled', 'cancel'],
    ['queued', 'cancelled', 'cancel'],
    ['running', 'cancelled', 'cancel'],
  ])('%s -> %s is allowed via %s', (from, to, via) => {
    expect(canExperimentTransition(from, to, via)).toBe(true);
    expect(() => assertExperimentTransition(from, to, via)).not.toThrow();
  });

  it('allows exactly the listed moves and no others', () => {
    const vias: ExperimentVia[] = ['start', 'dispatch', 'adhoc', 'derive', 'extend', 'cancel'];
    let allowed = 0;
    for (const from of EXPERIMENT) for (const to of EXPERIMENT) for (const via of vias) if (from !== to && canExperimentTransition(from, to, via)) allowed += 1;
    expect(allowed).toBe(10);
  });

  it('only the derivation can write completed or partial (D-8 starts here)', () => {
    for (const via of ['start', 'dispatch', 'adhoc', 'extend', 'cancel'] as ExperimentVia[]) {
      for (const from of EXPERIMENT) {
        expect(canExperimentTransition(from, 'completed', via)).toBe(from === 'completed');
        expect(canExperimentTransition(from, 'partial', via)).toBe(from === 'partial');
      }
    }
  });

  it('completed and partial reopen only through extend; cancelled never reopens', () => {
    expect(canExperimentTransition('completed', 'running', 'derive')).toBe(false);
    expect(canExperimentTransition('partial', 'running', 'dispatch')).toBe(false);
    for (const via of ['start', 'dispatch', 'adhoc', 'derive', 'extend', 'cancel'] as ExperimentVia[]) {
      for (const to of EXPERIMENT) if (to !== 'cancelled') expect(canExperimentTransition('cancelled', to, via)).toBe(false);
    }
  });

  it('a write that keeps the status is not a transition', () => {
    for (const s of EXPERIMENT) expect(canExperimentTransition(s, s, 'derive')).toBe(true);
  });

  it('names what it refused', () => {
    expect(() => assertExperimentTransition('completed', 'queued', 'start')).toThrow(InvalidTransitionError);
    expect(() => assertExperimentTransition('completed', 'queued', 'start')).toThrow('experiment cannot go from completed to queued via start');
  });

  it('guards for the endpoints', () => {
    expect(EXPERIMENT.filter(canStart)).toEqual(['draft']);
    expect(EXPERIMENT.filter(canCancel)).toEqual(['draft', 'queued', 'running']);
    expect(EXPERIMENT.filter(canExtend)).toEqual(['draft', 'queued', 'running', 'completed', 'partial']);
    expect(canResume('running', 'circuit breaker')).toBe(true);
    expect(canResume('running', null)).toBe(false);
    expect(canResume('completed', 'circuit breaker')).toBe(false);
  });
});

describe('trial transitions', () => {
  it('allows the card table and nothing else', () => {
    const allowed: string[] = [];
    for (const from of TRIAL) for (const to of TRIAL) if (canTrialTransition(from, to)) allowed.push(`${from}>${to}`);
    expect(allowed.sort()).toEqual(['pending>cancelled', 'pending>running', 'running>cancelled', 'running>done', 'running>errored', 'running>pending'].sort());
  });

  it('done, errored and cancelled are terminal', () => {
    for (const from of ['done', 'errored', 'cancelled'] as TrialStatus[]) for (const to of TRIAL) expect(canTrialTransition(from, to)).toBe(false);
    expect(() => assertTrialTransition('done', 'pending')).toThrow('trial cannot go from done to pending');
  });
});
