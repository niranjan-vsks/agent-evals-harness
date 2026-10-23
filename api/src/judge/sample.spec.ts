import { INestApplication } from '@nestjs/common';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { PrismaService } from '../prisma/prisma.service';
import { configBody, createTestApp, doneResult, FakeWorker } from '../test-support/app';
import { TrialResult, TrialSpec } from '../worker-client/types';
import { Candidate, loadCandidates, stratifiedDraw, toBlindLine, writeSample } from './sample';

const TASKS = ['jdg-01-summary', 'jdg-02-commit', 'jdg-03-docstring', 'jdg-04-flaky', 'mem-06-release'];
const REASONING = 'SENTINEL-REASONING-9f3';
const EVIDENCE = 'SENTINEL-EVIDENCE-4c1';
const HASH = 'a'.repeat(64);

function candidate(task: string, config: string, i: number): Candidate {
  return {
    trialId: `T-${task}-${config === 'cfgA' ? 'x' : 'y'}-${i}`, // does not contain the config id, which must never be in the file
    graderIndex: 0,
    taskId: task,
    configId: config,
    taskPrompt: `prompt of ${task}`,
    rubric: [{ id: 'c1', criterion: 'does the thing' }],
    inputs: [{ name: 'final_response', text: `answer ${i}` }],
  };
}

const grid = (perCell: number) => TASKS.flatMap((t) => ['cfgA', 'cfgB'].flatMap((c) => Array.from({ length: perCell }, (_, i) => candidate(t, c, i))));

describe('stratifiedDraw', () => {
  it('draws 30 as 6 per task and 3 per config (DESIGN 8.2 step 2)', () => {
    const draw = stratifiedDraw(grid(4), 30, 1);
    expect(draw.chosen).toHaveLength(30);
    expect(draw.short).toBe(false);
    expect(Object.values(draw.perCell)).toEqual(Array(10).fill(3));
    for (const t of TASKS) expect(draw.chosen.filter((c) => c.taskId === t)).toHaveLength(6);
    for (const t of TASKS) for (const c of ['cfgA', 'cfgB']) expect(draw.chosen.filter((x) => x.taskId === t && x.configId === c)).toHaveLength(3);
    expect(new Set(draw.chosen.map((c) => c.trialId)).size).toBe(30);
  });

  it('is reproducible for a seed, differs for another, and is not grouped by cell', () => {
    const ids = (seed: number) => stratifiedDraw(grid(4), 30, seed).chosen.map((c) => c.trialId);
    expect(ids(5)).toEqual(ids(5));
    expect(ids(5)).not.toEqual(ids(6));
    const order = ids(5).map((id) => id.split('-').slice(1, 3).join('-'));
    const switches = order.filter((x, i) => i > 0 && x !== order[i - 1]).length;
    expect(switches).toBeGreaterThan(15);
  });

  it('spreads a small n over distinct cells instead of favouring the first task ids', () => {
    const draw = stratifiedDraw(grid(4), 4, 1);
    expect(draw.chosen).toHaveLength(4);
    expect(Object.keys(draw.perCell)).toHaveLength(4);
    const seen = new Set<string>();
    for (let seed = 1; seed <= 25; seed++) stratifiedDraw(grid(4), 4, seed).chosen.forEach((c) => seen.add(c.taskId));
    expect(seen.size).toBe(TASKS.length);
  });

  it('takes what exists when a cell runs dry, and says it came up short', () => {
    const uneven = [...grid(1), ...grid(4).filter((c) => c.configId === 'cfgA')];
    const draw = stratifiedDraw(uneven, 100, 1);
    expect(draw.chosen).toHaveLength(uneven.length);
    expect(draw.short).toBe(true);
    const enough = stratifiedDraw(uneven, 12, 1);
    expect(enough.chosen).toHaveLength(12);
    expect(enough.short).toBe(false);
  });

  it('returns nothing for no candidates', () => {
    expect(stratifiedDraw([], 5, 1)).toMatchObject({ chosen: [], short: true });
  });
});

describe('toBlindLine (D-15)', () => {
  it('writes exactly the fields a labeler needs, even when handed more', () => {
    const rich = { ...candidate('jdg-01-summary', 'cfgA', 0), passed: true, reasoning: REASONING, criteria: [{ id: 'c1', met: true }], configName: 'memory seeded' };
    const line = toBlindLine(rich as Candidate);
    expect(Object.keys(line).sort()).toEqual(['grader_index', 'inputs', 'rubric', 'task_id', 'task_prompt', 'trial_id']);
    expect(JSON.stringify(line)).not.toMatch(/passed|reasoning|SENTINEL|cfgA|seeded/);
  });
});

describe('judge:sample on stored trials', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let worker: FakeWorker;
  let http: ReturnType<typeof request>;
  const mine = new Set<string>();
  const configs: Record<string, string> = {};
  const specs: TrialSpec[] = [];

  function judged(spec: TrialSpec, passed: boolean, withInputs = true): TrialResult {
    return doneResult(spec, {
      passed,
      grader_results: [
        {
          grader_index: 0,
          grader_type: 'llm_judge',
          passed,
          details: { criteria: [{ id: 'c1', met: passed, evidence: EVIDENCE }], model_pass: passed, ...(withInputs ? { judged_inputs: [{ name: 'final_response', text: `text for ${spec.trial_id}` }] } : {}) },
          reasoning: REASONING,
          judge_model_id: 'model-a',
          judge_prompt_hash: HASH,
          duration_ms: 5,
        },
      ],
    });
  }

  beforeAll(async () => {
    worker = new FakeWorker();
    ({ app, prisma } = await createTestApp(worker));
    http = request(app.getHttpServer());
    configs.A = (await http.post('/configs').send(configBody({ name: 'memory off' }, { max_steps: 61 }))).body.id;
    configs.B = (await http.post('/configs').send(configBody({ name: 'memory seeded' }, { max_steps: 61, memory: { mode: 'seeded', fixture: 'team-memory-v1' } }))).body.id;
    worker.run = (spec) => {
      specs.push(spec);
      return judged(spec, specs.length % 2 === 0);
    };
    for (const task of TASKS) {
      for (const cfg of ['A', 'B']) {
        for (let i = 0; i < 2; i++) {
          const res = await http.post('/trials/adhoc').send({ config_id: configs[cfg], task_id: task });
          expect(res.status).toBe(201);
          mine.add(res.body.trial.id);
        }
      }
    }
  }, 120000);
  afterAll(async () => {
    await app.close();
  });

  it('gives the worker the judge model when the task has an llm_judge grader', () => {
    expect(specs).toHaveLength(20);
    for (const s of specs) expect(s.judge_model).toMatchObject({ id: 'model-a', slug: 'anthropic/claude-haiku-5.5', api_key_env: 'OPENROUTER_API_KEY' });
  });

  it('loads the stored judge results with the rubric from the task and the text the judge saw', async () => {
    const { candidates } = await loadCandidates(prisma, { includeAdhoc: true });
    const own = candidates.filter((c) => mine.has(c.trialId));
    expect(own).toHaveLength(20);
    const first = own.find((c) => c.taskId === 'jdg-01-summary')!;
    expect(first.rubric.map((r) => r.id)).toEqual(['c1', 'c2', 'c3', 'c4']);
    expect(first.taskPrompt).toContain('Summarize the incident');
    expect(first.inputs[0].text).toBe(`text for ${first.trialId}`);
  });

  it('writes a blind file: no verdict, no reasoning, no config', async () => {
    const { candidates } = await loadCandidates(prisma, { includeAdhoc: true });
    const own = candidates.filter((c) => mine.has(c.trialId));
    const draw = stratifiedDraw(own, 10, 3);
    expect(Object.values(draw.perCell)).toEqual(Array(10).fill(1));
    const path = join(mkdtempSync(join(tmpdir(), 'sample-')), 'judge-validation', 'sample.jsonl');
    writeSample(path, draw.chosen);

    const text = readFileSync(path, 'utf8');
    const lines = text.trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines).toHaveLength(10);
    const forbidden = new Set(['passed', 'pass', 'reasoning', 'criteria', 'met', 'evidence', 'model_pass', 'details', 'config_id', 'config', 'judge_model_id']);
    const walk = (v: unknown): string[] => (Array.isArray(v) ? v.flatMap(walk) : v && typeof v === 'object' ? Object.entries(v).flatMap(([k, x]) => [k, ...walk(x)]) : []);
    for (const line of lines) {
      expect(Object.keys(line).sort()).toEqual(['grader_index', 'inputs', 'rubric', 'task_id', 'task_prompt', 'trial_id']);
      expect(walk(line).filter((k) => forbidden.has(k))).toEqual([]);
    }
    expect(text).not.toContain(REASONING);
    expect(text).not.toContain(EVIDENCE);
    expect(text).not.toContain(configs.A);
    expect(text).not.toContain(configs.B);
    expect(text).not.toContain('memory seeded');
  });

  it('skips a judge result that did not record what the judge saw, and says so', async () => {
    worker.run = (spec) => judged(spec, true, false);
    const res = await http.post('/trials/adhoc').send({ config_id: configs.A, task_id: 'jdg-04-flaky' });
    const { candidates, skipped } = await loadCandidates(prisma, { includeAdhoc: true });
    expect(skipped).toBeGreaterThanOrEqual(1);
    expect(candidates.some((c) => c.trialId === res.body.trial.id)).toBe(false);
  });

  it('leaves ad hoc trials out unless asked: they are hand runs, not the pilot or full run', async () => {
    const { candidates } = await loadCandidates(prisma);
    expect(candidates.filter((c) => mine.has(c.trialId))).toEqual([]);
    const all = await loadCandidates(prisma, { includeAdhoc: true });
    expect(all.candidates.filter((c) => mine.has(c.trialId))).toHaveLength(20);
  });

  it('draws only from the experiment it is told to', async () => {
    const first = await prisma.trial.findFirstOrThrow({ where: { id: [...mine][0] } });
    const { candidates } = await loadCandidates(prisma, { experimentId: first.experimentId });
    expect(candidates.map((c) => c.trialId)).toEqual([first.id]);
  });
});
