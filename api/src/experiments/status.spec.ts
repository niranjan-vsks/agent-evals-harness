import { countsFrom, deriveExperimentStatus, EMPTY_COUNTS, TrialCounts, totalOf } from './status';

const c = (over: Partial<TrialCounts>): TrialCounts => ({ ...EMPTY_COUNTS, ...over });

describe('deriveExperimentStatus (DATA_MODEL 2.6)', () => {
  it('is running while any trial is pending or running', () => {
    expect(deriveExperimentStatus(c({ pending: 3, done: 1 }), 'running')).toBe('running');
    expect(deriveExperimentStatus(c({ running: 1, errored: 5 }), 'running')).toBe('running');
    expect(deriveExperimentStatus(c({ pending: 1, errored: 1 }), 'running')).toBe('running');
  });

  it('is completed iff every trial is done', () => {
    expect(deriveExperimentStatus(c({ done: 16 }), 'running')).toBe('completed');
  });

  it('is partial once an errored or cancelled trial remains and nothing is in flight (D-8)', () => {
    expect(deriveExperimentStatus(c({ done: 14, errored: 2 }), 'running')).toBe('partial');
    expect(deriveExperimentStatus(c({ done: 14, cancelled: 2 }), 'running')).toBe('partial');
    expect(deriveExperimentStatus(c({ errored: 16 }), 'running')).toBe('partial');
  });

  it('never yields completed while an errored trial exists, for any counts', () => {
    for (let pending = 0; pending <= 2; pending++)
      for (let running = 0; running <= 2; running++)
        for (let done = 0; done <= 2; done++)
          for (let errored = 1; errored <= 2; errored++)
            for (let cancelled = 0; cancelled <= 2; cancelled++)
              for (const cur of ['queued', 'running', 'completed', 'partial'] as const)
                expect(deriveExperimentStatus({ pending, running, done, errored, cancelled }, cur)).not.toBe('completed');
  });

  it('stays queued until the first trial leaves pending', () => {
    expect(deriveExperimentStatus(c({ pending: 16 }), 'queued')).toBe('queued');
    expect(deriveExperimentStatus(c({ pending: 15, running: 1 }), 'queued')).toBe('running');
    expect(deriveExperimentStatus(c({ pending: 15, done: 1 }), 'queued')).toBe('running');
    expect(deriveExperimentStatus(c({ pending: 16 }), 'running')).toBe('running');
  });

  it('does not touch a draft, a cancelled experiment or one with no trials', () => {
    expect(deriveExperimentStatus(c({ done: 4 }), 'cancelled')).toBe('cancelled');
    expect(deriveExperimentStatus(c({ pending: 4 }), 'draft')).toBe('draft');
    expect(deriveExperimentStatus(EMPTY_COUNTS, 'running')).toBe('running');
  });

  it('reopens a finished experiment when an extend adds pending trials', () => {
    expect(deriveExperimentStatus(c({ done: 16, pending: 8 }), 'completed')).toBe('running');
    expect(deriveExperimentStatus(c({ done: 15, errored: 1, pending: 8 }), 'partial')).toBe('running');
  });

  it('folds grouped rows into counts', () => {
    const counts = countsFrom([
      { status: 'done', count: 10 },
      { status: 'errored', count: 2 },
      { status: 'pending', count: 4 },
    ]);
    expect(counts).toEqual({ pending: 4, running: 0, done: 10, errored: 2, cancelled: 0 });
    expect(totalOf(counts)).toBe(16);
    expect(EMPTY_COUNTS).toEqual({ pending: 0, running: 0, done: 0, errored: 0, cancelled: 0 });
  });
});
