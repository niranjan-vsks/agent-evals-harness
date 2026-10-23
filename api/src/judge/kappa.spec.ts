import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../prisma/prisma.service';
import { configBody, createTestApp, doneResult, FakeWorker } from '../test-support/app';
import { TrialResult, TrialSpec } from '../worker-client/types';
import { computeValidation, labelSetHash, LabelLine, parseLabels, runKappa } from './kappa';

const rep = <T>(x: T, n: number) => Array.from({ length: n }, () => x);
const line = (over: Partial<LabelLine> = {}) => JSON.stringify({ trial_id: 'T1', grader_index: 0, human_passed: true, labeler: 'author', ...over });

describe('parseLabels', () => {
  it('reads 1 object per line and ignores blank lines', () => {
    const got = parseLabels(`${line()}\n\n${line({ trial_id: 'T2', human_passed: false, note: 'cut off' })}\r\n`);
    expect(got).toEqual([
      { trial_id: 'T1', grader_index: 0, human_passed: true, labeler: 'author', note: null },
      { trial_id: 'T2', grader_index: 0, human_passed: false, labeler: 'author', note: 'cut off' },
    ]);
  });

  it.each([
    ['not json', '{nope', 'line 2: not valid JSON'],
    ['no trial', line({ trial_id: '' }), 'trial_id'],
    ['float index', line({ grader_index: 0.5 }), 'grader_index'],
    ['human_passed as a string', line({ human_passed: 'yes' as unknown as boolean }), 'human_passed'],
    ['no labeler', line({ labeler: '' }), 'labeler'],
  ])('rejects %s, naming the line', (_name, text, message) => {
    expect(() => parseLabels(`${line({ trial_id: 'OK' })}\n${text}`)).toThrow(message);
  });

  it('rejects the same item labelled twice by the same labeler, and allows a second labeler', () => {
    expect(() => parseLabels(`${line()}\n${line()}`)).toThrow('already labelled');
    expect(parseLabels(`${line()}\n${line({ labeler: 'second' })}`)).toHaveLength(2);
  });
});

describe('labelSetHash', () => {
  const a = parseLabels(`${line({ trial_id: 'A' })}\n${line({ trial_id: 'B', human_passed: false })}`);
  it('ignores order and notes, and changes when a label changes', () => {
    expect(labelSetHash([...a].reverse())).toBe(labelSetHash(a));
    expect(labelSetHash(a.map((l) => ({ ...l, note: 'x' })))).toBe(labelSetHash(a));
    expect(labelSetHash(a.map((l) => ({ ...l, human_passed: !l.human_passed })))).not.toBe(labelSetHash(a));
    expect(labelSetHash(a)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('computeValidation', () => {
  it('matches the reference for 30 items (12 agree pass, 3 judge-only, 4 human-only, 11 agree fail)', () => {
    const pairs = [...rep([true, true] as const, 12), ...rep([true, false] as const, 3), ...rep([false, true] as const, 4), ...rep([false, false] as const, 11)];
    const r = computeValidation(pairs);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.validation).toMatchObject({ nItems: 30, agreementRaw: 0.7667, kappa: 0.5333, kappaCiLow: 0.2, kappaCiHigh: 0.8, policy: 'flagged', usedResamples: 10000 });
  });

  it('is trusted at 0.6 and above, excluded below 0.4', () => {
    const strong = computeValidation([...rep([true, true] as const, 14), ...rep([false, false] as const, 14), [true, false], [false, true]]);
    expect(strong.ok && strong.validation.policy).toBe('trusted');
    const weak = computeValidation([...rep([true, true] as const, 8), ...rep([false, false] as const, 8), ...rep([true, false] as const, 7), ...rep([false, true] as const, 7)]);
    expect(weak.ok && weak.validation.kappa).toBeLessThan(0.4);
    expect(weak.ok && weak.validation.policy).toBe('excluded');
  });

  it('refuses to validate when kappa is undefined or there is nothing to compare', () => {
    expect(computeValidation(rep([true, true] as const, 40))).toMatchObject({ ok: false, reason: expect.stringContaining('0/0') });
    expect(computeValidation([[true, true]], { minItems: 0 })).toMatchObject({ ok: false, reason: expect.stringContaining('at least 2') });
    const few = [...rep([true, true] as const, 8), ...rep([false, false] as const, 8)];
    expect(computeValidation(few)).toMatchObject({ ok: false, reason: expect.stringContaining('at least 30') });
    expect(computeValidation(few, { minItems: 10 })).toMatchObject({ ok: true });
  });

  it('is reproducible', () => {
    const pairs = [...rep([true, true] as const, 15), ...rep([false, true] as const, 6), ...rep([false, false] as const, 15)];
    expect(computeValidation(pairs)).toEqual(computeValidation(pairs));
  });
});

describe('judge:kappa on stored trials', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let worker: FakeWorker;
  let http: ReturnType<typeof request>;
  let configId: string;
  const HASH_A = 'a'.repeat(64);
  const HASH_B = 'b'.repeat(64);

  function judged(spec: TrialSpec, passed: boolean, hash: string): TrialResult {
    return doneResult(spec, {
      passed,
      grader_results: [
        { grader_index: 0, grader_type: 'judge-placeholder' as 'llm_judge', passed, details: { judged_inputs: [] }, reasoning: 'r', judge_model_id: 'model-a', judge_prompt_hash: hash, duration_ms: 1 },
      ],
    });
  }

  /** One stored judged trial whose judge verdict is `passed`; returns its id. */
  async function trial(passed: boolean, hash = HASH_A, task = 'jdg-01-summary'): Promise<string> {
    worker.run = (spec) => {
      const r = judged(spec, passed, hash);
      r.grader_results[0].grader_type = 'llm_judge';
      return r;
    };
    const res = await http.post('/trials/adhoc').send({ config_id: configId, task_id: task });
    expect(res.status).toBe(201);
    return res.body.trial.id;
  }

  async function labelled(pattern: [boolean, boolean][], hash = HASH_A): Promise<LabelLine[]> {
    const out: LabelLine[] = [];
    for (const [judge, human] of pattern) out.push({ trial_id: await trial(judge, hash), grader_index: 0, human_passed: human, labeler: 'author', note: null });
    return out;
  }

  beforeAll(async () => {
    worker = new FakeWorker();
    ({ app, prisma } = await createTestApp(worker));
    http = request(app.getHttpServer());
    configId = (await http.post('/configs').send(configBody({ name: 'kappa' }, { max_steps: 62 }))).body.id;
  });
  afterAll(async () => {
    await app.close();
  });

  const pattern30: [boolean, boolean][] = [...rep([true, true] as [boolean, boolean], 12), ...rep([true, false] as [boolean, boolean], 3), ...rep([false, true] as [boolean, boolean], 4), ...rep([false, false] as [boolean, boolean], 11)];

  it('stores the labels and 1 validation row with the numbers, the judge ids and the label set hash', async () => {
    const labels = await labelled(pattern30);
    const [run] = await runKappa(prisma, labels);
    expect(run).toMatchObject({ judgeModelId: 'model-a', judgePromptHash: HASH_A, labeler: 'author' });
    expect(run.outcome.ok).toBe(true);

    const row = await prisma.judgeValidation.findUniqueOrThrow({ where: { id: run.validationId! } });
    expect(row).toMatchObject({ judgeModelId: 'model-a', judgePromptHash: HASH_A, nItems: 30, policy: 'flagged', labelSetHash: labelSetHash(labels) });
    expect(row.kappa.toNumber()).toBe(0.5333);
    expect(row.agreementRaw.toNumber()).toBe(0.7667);
    expect([row.kappaCiLow.toNumber(), row.kappaCiHigh.toNumber()]).toEqual([0.2, 0.8]);

    const stored = await prisma.judgeLabel.findMany({ where: { trialId: { in: labels.map((l) => l.trial_id) } } });
    expect(stored).toHaveLength(30);
    expect(stored.filter((l) => l.humanPassed)).toHaveLength(16);
    expect(new Set(stored.map((l) => l.labeler))).toEqual(new Set(['author']));
  });

  it('is re-runnable: labels are updated in place and a new validation row is added', async () => {
    const labels = await labelled([...rep([true, true] as [boolean, boolean], 8), ...rep([false, false] as [boolean, boolean], 8), [true, false], [false, true]]);
    const first = (await runKappa(prisma, labels, { minItems: 2 }))[0];
    const flipped = labels.map((l, i) => (i === 0 ? { ...l, human_passed: false } : l));
    const second = (await runKappa(prisma, flipped, { minItems: 2 }))[0];
    expect(second.validationId).not.toBe(first.validationId);
    expect(await prisma.judgeLabel.count({ where: { trialId: labels[0].trial_id } })).toBe(1);
    expect((await prisma.judgeLabel.findFirstOrThrow({ where: { trialId: labels[0].trial_id } })).humanPassed).toBe(false);
    const rows = await prisma.judgeValidation.findMany({ where: { id: { in: [first.validationId!, second.validationId!] } } });
    expect(rows[0].labelSetHash).not.toBe(rows[1].labelSetHash);
  });

  it('writes 1 row per judge prompt version', async () => {
    const labels = [...(await labelled([[true, true], [false, false], [true, true], [false, true]], HASH_A)), ...(await labelled([[true, true], [false, false], [true, false], [false, false]], HASH_B))];
    const runs = await runKappa(prisma, labels, { minItems: 2 });
    expect(runs.map((r) => r.judgePromptHash).sort()).toEqual([HASH_A, HASH_B]);
    expect(runs.every((r) => r.outcome.ok && r.validationId)).toBe(true);
  });

  it('writes no validation row when the labels cannot validate a judge, but keeps the labels', async () => {
    const labels = await labelled(rep([true, true] as [boolean, boolean], 4));
    const [run] = await runKappa(prisma, labels, { minItems: 2 });
    expect(run.outcome).toMatchObject({ ok: false });
    expect(run.validationId).toBeNull();
    expect(await prisma.judgeLabel.count({ where: { trialId: { in: labels.map((l) => l.trial_id) } } })).toBe(4);
  });

  it('refuses, writing nothing, a label that points at nothing or at a deterministic grader', async () => {
    const good = await labelled([[true, true]]);
    const det = await http.post('/trials/adhoc').send({ config_id: configId, task_id: 'det-06-ini' });
    worker.run = (spec) => doneResult(spec);
    const detId = (await http.post('/trials/adhoc').send({ config_id: configId, task_id: 'det-06-ini' })).body.trial.id;
    expect(det.status).toBe(201);
    const before = await prisma.judgeLabel.count();
    await expect(runKappa(prisma, [...good, { trial_id: 'NOPE', grader_index: 0, human_passed: true, labeler: 'author' }])).rejects.toThrow('no such grader result');
    await expect(runKappa(prisma, [...good, { trial_id: detId, grader_index: 0, human_passed: true, labeler: 'author' }])).rejects.toThrow('not an llm_judge result');
    expect(await prisma.judgeLabel.count()).toBe(before);
  });

  it('wants 1 labeler at a time', async () => {
    const [a, b] = await labelled([[true, true], [false, false]]);
    const labels: LabelLine[] = [a, b, { ...a, labeler: 'second', human_passed: false }];
    await expect(runKappa(prisma, labels)).rejects.toThrow('--labeler');
    const [run] = await runKappa(prisma, labels, { labeler: 'author', minItems: 2 });
    expect(run.labeler).toBe('author');
    await expect(runKappa(prisma, labels, { labeler: 'nobody' })).rejects.toThrow('no labels by nobody');
  });
});
