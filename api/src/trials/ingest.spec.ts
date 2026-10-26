import { costUsd, countRateLimitEvents, erroredResult, FailureTask, ingest, IngestError, MAX_TRACE_BYTES } from './ingest';
import { trialSeed } from './seed';
import { doneResult } from '../test-support/app';
import { TrialSpec } from '../worker-client/types';

const PRICE = { input_price_per_mtok: 0.018, output_price_per_mtok: 0.09 };

const TASK: FailureTask = { taskCategory: 'neutral_deterministic', taskFixtureDir: 'fixtures/x', memoryMode: 'off' };

const spec = {
  trial_id: 'T1',
  attempt: 1,
  harness: 'hermes',
  model: { slug: 'openai/gpt-oss-20b' },
  task: { prompt: 'p' },
  memory_seed: null,
} as unknown as TrialSpec;

describe('costUsd', () => {
  it('multiplies tokens by the snapshot price per million tokens, to 6 places', () => {
    expect(costUsd(1_000_000, 0, PRICE).toString()).toBe('0.018');
    expect(costUsd(0, 1_000_000, PRICE).toString()).toBe('0.09');
    expect(costUsd(3000, 40, PRICE).toString()).toBe('0.000058'); // 3000 x 0.018/1e6 + 40 x 0.09/1e6 = 0.0000576
  });

  it('is exact in decimal arithmetic where binary floats are not', () => {
    // 0.1 + 0.2 style drift: 3 tokens at 0.1 per million is 0.0000003, which rounds to 0.
    expect(costUsd(3, 0, { input_price_per_mtok: 0.1, output_price_per_mtok: 0 }).toString()).toBe('0');
    expect(costUsd(7_000_000, 0, { input_price_per_mtok: 0.1, output_price_per_mtok: 0 }).toString()).toBe('0.7');
  });

  it('is 0 for no tokens', () => {
    expect(costUsd(0, 0, PRICE).toString()).toBe('0');
  });

  describe('cache-read tokens (D-7, DESIGN 13.14)', () => {
    const CACHED = { ...PRICE, cached_input_price_per_mtok: 0.009 };

    it('are charged at the cached price on top of input and output, which exclude them', () => {
      expect(costUsd(0, 0, CACHED, 1_000_000).toString()).toBe('0.009');
      // 3000 x 0.018/1e6 + 40 x 0.09/1e6 + 4288 x 0.009/1e6 = 0.0000576 + 0.000038592 = 0.000096192
      expect(costUsd(3000, 40, CACHED, 4288).toString()).toBe('0.000096');
    });

    it('null or no cache-read tokens add nothing', () => {
      expect(costUsd(3000, 40, CACHED, null).toString()).toBe(costUsd(3000, 40, CACHED).toString());
      expect(costUsd(3000, 40, CACHED, 0).toString()).toBe('0.000058');
    });

    it('a snapshot without the cached price (a trial dispatched before 0004) falls back to the input price, the upper bound', () => {
      expect(costUsd(0, 0, PRICE, 1_000_000).toString()).toBe('0.018');
    });
  });
});

describe('ingest', () => {
  it('maps a passing trial and computes cost from the snapshot', () => {
    const r = ingest(doneResult(spec), PRICE);
    expect(r.status).toBe('done');
    expect(r.passed).toBe(true);
    expect(r.exitReason).toBe('completed');
    expect(r.steps).toBe(2);
    expect(r.inputTokens).toBe(3000);
    expect(r.costUsd?.toString()).toBe('0.000058');
    expect(r.trace?.events).toHaveLength(7);
    expect(r.trace?.finalResponse).toBe('FINAL: 8081');
    expect(r.graders).toHaveLength(1);
    expect(r.errorClass).toBeNull();
  });

  it("charges the result's cache_read_tokens at the snapshot's cached price", () => {
    const cached = doneResult(spec);
    cached.outcome!.usage.cache_read_tokens = 2_000_000;
    const price = { ...PRICE, cached_input_price_per_mtok: 0.009 };
    expect(ingest(cached, price).costUsd?.toString()).toBe('0.018058'); // 0.000058 + 2 x 0.009
    expect(ingest(cached, PRICE).costUsd?.toString()).toBe('0.036058'); // no cached price: the input price, 0.000058 + 2 x 0.018
    const none = doneResult(spec);
    none.outcome!.usage.cache_read_tokens = null as unknown as number;
    expect(ingest(none, price).costUsd?.toString()).toBe('0.000058');
  });

  it('keeps a timed-out trial as a scored failure (R-2)', () => {
    const r = ingest(doneResult(spec, {}, 'timeout'), PRICE, TASK);
    expect(r.status).toBe('done');
    expect(r.passed).toBe(false);
    expect(r.exitReason).toBe('timeout');
  });

  describe('failure category (P6)', () => {
    it('a failed done result carries the category and evidence of the rules', () => {
      const r = ingest(doneResult(spec, {}, 'timeout'), PRICE, TASK);
      expect(r.failure).toEqual({ category: 'timeout', evidence: { rule: 2, category: 'timeout', detail: 'exit_reason is timeout: the runner stopped the trial' } });
      expect(ingest(doneResult(spec, {}, 'max_steps'), PRICE, TASK).failure?.category).toBe('step_exhaustion');
    });

    it('a plain wrong answer is wrong_answer and names the failed grader', () => {
      const bad = doneResult(spec, { passed: false });
      bad.grader_results[0].passed = false;
      const r = ingest(bad, PRICE, TASK);
      expect(r.failure).toMatchObject({ category: 'wrong_answer', evidence: { rule: 12, grader_index: 0 } });
    });

    it('the task context reaches the rules: a seeded memory task that ignored the memory is memory_ignored', () => {
      const bad = doneResult(spec, { passed: false });
      bad.grader_results[0].passed = false;
      bad.grader_results[0].details = { expected: 'Marco', extracted: 'Priya' };
      bad.trace!.memory_initial = { 'MEMORY.md': 'ingest is owned by Marco' };
      bad.trace!.final_response = 'FINAL: Priya';
      bad.trace!.events.push({ seq: 7, t_ms: 7, kind: 'memory_read', file: 'MEMORY.md', content: 'x', loaded_by: 'harness' });
      const seeded: FailureTask = { taskCategory: 'memory_dependent', taskFixtureDir: null, memoryMode: 'seeded' };
      expect(ingest(bad, PRICE, seeded).failure).toMatchObject({ category: 'memory_ignored', evidence: { rule: 10, event_seq: 7 } });
      expect(ingest(bad, PRICE, { ...seeded, memoryMode: 'off' }).failure?.category).toBe('wrong_answer');
    });

    it('a passed result and an errored result have no category', () => {
      expect(ingest(doneResult(spec), PRICE, TASK).failure).toBeNull();
      expect(ingest(doneResult(spec), PRICE).failure).toBeNull();
      expect(ingest(erroredResult('worker_crash', 'x'), PRICE, TASK).failure).toBeNull();
    });

    it('refuses a failed done result when the task context is missing, rather than guessing', () => {
      expect(() => ingest(doneResult(spec, {}, 'timeout'), PRICE)).toThrow(IngestError);
      expect(() => ingest(doneResult(spec, {}, 'timeout'), PRICE)).toThrow(/task context/);
    });
  });

  it('maps an errored result to a class and a message, with no cost and no trace', () => {
    const r = ingest(erroredResult('rate_limited', 'HTTP 429', [{ seq: 0, t_ms: 0, kind: 'api_call', http_status: 429 }]), PRICE);
    expect(r).toMatchObject({ status: 'errored', passed: null, exitReason: null, costUsd: null, errorClass: 'rate_limited', errorMessage: 'HTTP 429' });
    expect(r.trace).toBeNull();
    expect(r.partialTrace).toHaveLength(1);
    expect(r.rateLimitEvents).toBe(1);
  });

  it('counts api_call events with http_status 429 as rate_limit_events', () => {
    const events = [
      { seq: 0, t_ms: 0, kind: 'api_call', http_status: 429 },
      { seq: 1, t_ms: 0, kind: 'api_call', http_status: 200 },
      { seq: 2, t_ms: 0, kind: 'message', http_status: 429 },
    ];
    expect(countRateLimitEvents(events)).toBe(1);
  });

  it('D-14: rejects a result whose passed is not the AND of its graders', () => {
    const bad = doneResult(spec, { passed: false });
    bad.grader_results[0].passed = true;
    expect(() => ingest(bad, PRICE)).toThrow(IngestError);
    const bad2 = doneResult(spec, {}, 'completed');
    bad2.grader_results.push({ ...bad2.grader_results[0], grader_index: 1, passed: false });
    expect(() => ingest(bad2, PRICE)).toThrow(/D-14/);
  });

  it('accepts a multi-grader result only when every grader passed', () => {
    const ok = doneResult(spec);
    ok.grader_results.push({ ...ok.grader_results[0], grader_index: 1 });
    expect(ingest(ok, PRICE).passed).toBe(true);
  });

  it('D-13 and D-11 shapes: errored needs a class, done needs passed and a trace', () => {
    expect(() => ingest({ ...erroredResult('worker_crash', 'x'), error_class: null }, PRICE)).toThrow(IngestError);
    expect(() => ingest({ ...doneResult(spec), passed: null }, PRICE)).toThrow(IngestError);
    expect(() => ingest({ ...doneResult(spec), trace: null }, PRICE)).toThrow(IngestError);
    expect(() => ingest({ ...doneResult(spec), grader_results: [] }, PRICE)).toThrow(IngestError);
  });

  it('rejects a timed-out trial that claims to have passed', () => {
    const bad = doneResult(spec, {}, 'timeout');
    bad.passed = true;
    bad.grader_results[0].passed = true;
    expect(() => ingest(bad, PRICE)).toThrow(/timed-out/);
  });

  it('requires judge fields exactly for llm_judge graders', () => {
    const bad = doneResult(spec);
    bad.grader_results[0].grader_type = 'llm_judge';
    expect(() => ingest(bad, PRICE)).toThrow(IngestError);
  });

  it('rejects a trace above 5 MB', () => {
    const big = doneResult(spec);
    big.trace!.events[1].content = 'x'.repeat(MAX_TRACE_BYTES + 1);
    expect(() => ingest(big, PRICE)).toThrow(/larger than/);
  });
});

describe('trialSeed', () => {
  it('is a deterministic non-negative int32 of (seed, config, task, index)', () => {
    const a = trialSeed(1, 'cfg', 'det-06-ini', 0);
    expect(a).toBe(trialSeed(1, 'cfg', 'det-06-ini', 0));
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThanOrEqual(2 ** 31 - 1);
    expect(new Set([a, trialSeed(2, 'cfg', 'det-06-ini', 0), trialSeed(1, 'cfg2', 'det-06-ini', 0), trialSeed(1, 'cfg', 'det-07-x', 0), trialSeed(1, 'cfg', 'det-06-ini', 1)]).size).toBe(5);
  });
});
