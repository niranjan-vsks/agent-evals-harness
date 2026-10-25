import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { ulid } from '../../common/ulid';
import { PrismaClient } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { databaseUrl } from '../../test-support/db';
import { backfill, formatReport } from '../backfill';

/**
 * The upgrade path of a database that already holds failed trials: migrations 0001 and 0002, legacy rows with no category, then
 * 0003_failure_category and the backfill. It runs on a database of its own so that the shared test database keeps its validated
 * constraint.
 */

const MIGRATIONS = join(__dirname, '..', '..', '..', 'prisma', 'migrations');
const sql = (dir: string) => readFileSync(join(MIGRATIONS, dir, 'migration.sql'), 'utf8');

const events = (parts: Array<Record<string, unknown>>) => parts.map((p, i) => ({ seq: i, t_ms: i, ...p }));
const MSG = { kind: 'message', role: 'user', content: 'task', step: 0 };

describe('failures:backfill on a database that predates 0003_failure_category', () => {
  const dbName = `p6_backfill_${Date.now().toString(36)}`;
  let admin: Pool;
  let pool: Pool;
  let prisma: PrismaService;
  const ids = { exp: ulid(), expB: ulid(), cfgSeeded: ulid(), cfgOff: ulid() };
  const trial: Record<string, string> = {};

  async function insertTrial(key: string, over: { exp?: string; cfg?: string; task: string; index: number; status?: string; passed?: boolean | null; exit?: string | null; steps?: number }) {
    const id = ulid();
    trial[key] = id;
    await pool.query(
      `INSERT INTO trial (id, experiment_id, config_id, task_id, task_version_hash, trial_index, seed, status, passed, exit_reason, steps, price_snapshot)
       VALUES ($1, $2, $3, $4, $5, $6, 1, $7::trial_status, $8, $9::exit_reason, $10, '{}')`,
      [id, over.exp ?? ids.exp, over.cfg ?? ids.cfgOff, over.task, `hash-${over.task}`, over.index, over.status ?? 'done', 'passed' in over ? over.passed : false, 'exit' in over ? over.exit : 'completed', over.steps ?? 3],
    );
    return id;
  }
  async function trace(trialId: string, parts: Array<Record<string, unknown>>, finalResponse: string | null, memoryInitial: object = {}) {
    await pool.query(
      `INSERT INTO trace (trial_id, harness_id, harness_version, model_slug, events, memory_initial, memory_final, skills_invoked, notes, final_response)
       VALUES ($1, 'h', 'v1', 'slug/x', $2::jsonb, $3::jsonb, '{}', ARRAY[]::text[], ARRAY[]::text[], $4)`,
      [trialId, JSON.stringify(events(parts)), JSON.stringify(memoryInitial), finalResponse],
    );
  }
  async function grader(trialId: string, index: number, type: string, passed: boolean, details: object) {
    await pool.query(
      `INSERT INTO grader_result (id, trial_id, grader_index, grader_type, passed, details, judge_model_id, judge_prompt_hash, duration_ms)
       VALUES ($1, $2, $3, $4::grader_type, $5, $6::jsonb, $7, $8, 1)`,
      [ulid(), trialId, index, type, passed, JSON.stringify(details), type === 'llm_judge' ? 'model-a' : null, type === 'llm_judge' ? 'hash' : null],
    );
  }
  const row = async (id: string) =>
    (await pool.query(`SELECT failure_category, failure_evidence FROM trial WHERE id = $1`, [id])).rows[0] as { failure_category: string | null; failure_evidence: { rule: number } | null };
  const validated = async () =>
    (await pool.query(`SELECT convalidated FROM pg_constraint WHERE conname = 'trial_failure_category_iff_failed'`)).rows[0]?.convalidated as boolean | undefined;

  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl() });
    await admin.query(`CREATE DATABASE "${dbName}" TEMPLATE template0 ENCODING 'UTF8'`);
    const url = new URL(databaseUrl());
    url.pathname = `/${dbName}`;
    pool = new Pool({ connectionString: url.toString() });
    await pool.query(sql('0001_init'));
    await pool.query(sql('0002_invariants'));

    await pool.query(
      `INSERT INTO model (id, display_name, slug, base_url, api_key_env, input_price_per_mtok, output_price_per_mtok, context_window, roles)
       VALUES ('model-b', 'b', 'slug/x', 'http://x', 'KEY', 1, 2, 1000, ARRAY['candidate'])`,
    );
    await pool.query(`INSERT INTO harness (id, version, capabilities) VALUES ('h', 'v1', '{}')`);
    for (const [id, name, settings] of [
      [ids.cfgOff, 'memory off', { memory: { mode: 'off' } }],
      [ids.cfgSeeded, 'memory seeded', { memory: { mode: 'seeded' } }],
    ] as const) {
      await pool.query(
        `INSERT INTO config (id, name, harness_id, harness_version, model_id, model_slug, settings, config_hash) VALUES ($1, $2, 'h', 'v1', 'model-b', 'slug/x', $3::jsonb, $4)`,
        [id, name, JSON.stringify(settings), `hash-${id}`],
      );
    }
    const tasks: Array<[string, string, string | null, object[]]> = [
      ['mem-01-owner', 'memory_dependent', null, [{ type: 'exact_match', expected: 'Marco' }]],
      ['det-01-count', 'neutral_deterministic', 'fixtures/det-01', [{ type: 'exact_match', expected: '37' }]],
      ['jdg-01-summary', 'neutral_judged', 'fixtures/jdg-01', [{ type: 'llm_judge' }]],
    ];
    for (const [id, category, fixture, graders] of tasks) {
      await pool.query(
        `INSERT INTO task (id, version_hash, category, prompt, fixture_dir, graders, discriminates, tags, is_current)
         VALUES ($1, $2, $3::task_category, 'p', $4, $5::jsonb, ARRAY['model'], ARRAY[]::text[], true)`,
        [id, `hash-${id}`, category, fixture, JSON.stringify(graders)],
      );
    }
    for (const id of [ids.exp, ids.expB]) {
      await pool.query(`INSERT INTO experiment (id, name, status, n_trials, seed, phase, worker_manifest) VALUES ($1, 'e', 'running', 3, 1, 'full', '{}')`, [id]);
    }

    // Legacy rows: done and failed, no category. Each lands in a different category.
    await insertTrial('maxsteps', { task: 'det-01-count', index: 0, exit: 'max_steps', steps: 15 });
    await trace(trial.maxsteps, [MSG], '');
    await grader(trial.maxsteps, 0, 'exact_match', false, { expected: '37', extracted: '' });

    await insertTrial('wrong', { task: 'det-01-count', index: 1 });
    await trace(trial.wrong, [MSG, { kind: 'api_call', step: 1, status: 'ok' }, { kind: 'message', role: 'assistant', step: 1, content: 'FINAL: 5' }], 'FINAL: 5');
    await grader(trial.wrong, 0, 'exact_match', false, { expected: '37', extracted: '5' });

    await insertTrial('ignored', { task: 'mem-01-owner', index: 0, cfg: ids.cfgSeeded, steps: 1 });
    await trace(trial.ignored, [MSG, { kind: 'memory_read', file: 'MEMORY.md', content: 'x', loaded_by: 'harness' }, { kind: 'message', role: 'assistant', step: 1, content: 'FINAL: Priya' }], 'FINAL: Priya', {
      'MEMORY.md': 'ingest is owned by Marco',
    });
    await grader(trial.ignored, 0, 'exact_match', false, { expected: 'Marco', extracted: 'Priya' });

    await insertTrial('judged', { task: 'jdg-01-summary', index: 0 });
    await trace(trial.judged, [MSG, { kind: 'tool_call', step: 1, call_id: 'c', tool: 'files', args: {} }, { kind: 'tool_result', call_id: 'c', output: 'ok', is_error: false }], 'a summary');
    await grader(trial.judged, 0, 'llm_judge', false, { criteria: [{ id: 'c1', met: true }, { id: 'c2', met: false }] });

    await insertTrial('other-exp', { exp: ids.expB, task: 'det-01-count', index: 0, exit: 'timeout' });
    await trace(trial['other-exp'], [MSG], null);
    await grader(trial['other-exp'], 0, 'exact_match', false, { reason: 'no final response', expected: '37', extracted: null });

    await insertTrial('passed', { task: 'det-01-count', index: 2, passed: true });
    await insertTrial('pending', { task: 'det-01-count', index: 3, status: 'pending', passed: null, exit: null });

    await pool.query(sql('0003_failure_category'));
    const url2 = new URL(databaseUrl());
    url2.pathname = `/${dbName}`;
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url2.toString() }) }) as unknown as PrismaService;
  }, 60_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await admin?.end();
  });

  it('the migration leaves the old rows without a category and the constraint NOT VALID, yet enforced for new rows', async () => {
    expect((await row(trial.maxsteps)).failure_category).toBeNull();
    expect(await validated()).toBe(false);
    await expect(pool.query(`INSERT INTO trial (id, experiment_id, config_id, task_id, task_version_hash, trial_index, seed, status, passed, exit_reason, price_snapshot)
      VALUES ('x', $1, $2, 'det-01-count', 'hash-det-01-count', 9, 1, 'done', false, 'completed', '{}')`, [ids.exp, ids.cfgOff])).rejects.toThrow(/trial_failure_category_iff_failed/);
  });

  it('a dry run reports what it would do and writes nothing', async () => {
    const r = await backfill(prisma, { dryRun: true });
    expect(r).toMatchObject({ examined: 5, updated: 5, dryRun: true, constraintValidated: false });
    expect((await row(trial.maxsteps)).failure_category).toBeNull();
    expect(await validated()).toBe(false);
  });

  it('restricted to one experiment it fills that one and leaves the constraint unvalidated while another still lacks categories', async () => {
    const r = await backfill(prisma, { experimentId: ids.expB });
    expect(r.examined).toBe(1);
    expect((await row(trial['other-exp'])).failure_category).toBe('timeout');
    expect((await row(trial.wrong)).failure_category).toBeNull();
    expect(r.constraintValidated).toBe(false);
    expect(await validated()).toBe(false);
  });

  it('fills every failed trial with the category of the rules, leaves passed and pending trials alone, and validates the constraint', async () => {
    const r = await backfill(prisma, {});
    expect(r).toMatchObject({ examined: 5, updated: 4, unchanged: 1, constraintValidated: true, dryRun: false });
    const got = Object.fromEntries(await Promise.all(['maxsteps', 'wrong', 'ignored', 'judged', 'other-exp'].map(async (k) => [k, (await row(trial[k])).failure_category])));
    expect(got).toEqual({ maxsteps: 'step_exhaustion', wrong: 'wrong_answer', ignored: 'memory_ignored', judged: 'judge_criteria_unmet', 'other-exp': 'timeout' });
    expect((await row(trial.maxsteps)).failure_evidence).toMatchObject({ rule: 1, category: 'step_exhaustion' });
    expect((await row(trial.ignored)).failure_evidence).toMatchObject({ rule: 10, event_seq: 1, grader_index: 0 });
    expect(await row(trial.passed)).toEqual({ failure_category: null, failure_evidence: null });
    expect(await row(trial.pending)).toEqual({ failure_category: null, failure_evidence: null });
    expect(await validated()).toBe(true);
    expect(r.totals).toMatchObject({ step_exhaustion: 1, wrong_answer: 1, judge_criteria_unmet: 1, memory_ignored: 1, timeout: 1 });
    expect(r.wrongAnswerShare).toBeCloseTo(1 / 5, 12);
  });

  it('prints a histogram per experiment and config', async () => {
    const r = await backfill(prisma, {});
    const byConfig = Object.fromEntries(r.histogram.map((h) => [`${h.experimentId === ids.exp ? 'A' : 'B'}/${h.configName}`, h.total]));
    expect(byConfig).toEqual({ 'A/memory off': 3, 'A/memory seeded': 1, 'B/memory off': 1 });
    const text = formatReport(r);
    expect(text).toContain('5 failed trial(s) examined, 0 updated, 5 unchanged');
    expect(text).toMatch(/memory seeded\s+1(\s+0){9}\s+1(\s+0){2}/);
    expect(text).toContain('wrong_answer is 20.0 percent of the failures');
    expect(text).not.toContain('STOP CONDITION');
    expect(text).toContain('constraint trial_failure_category_iff_failed is validated');
  });

  it('is idempotent: a second run changes nothing', async () => {
    const before = (await pool.query(`SELECT id, failure_category, failure_evidence FROM trial ORDER BY id`)).rows;
    const r = await backfill(prisma, {});
    expect(r.updated).toBe(0);
    expect((await pool.query(`SELECT id, failure_category, failure_evidence FROM trial ORDER BY id`)).rows).toEqual(before);
  });

  it('applies a judge label that arrived after ingest: the failed llm_judge trial becomes grader_disagreement', async () => {
    expect(await row(trial.judged)).toMatchObject({ failure_category: 'judge_criteria_unmet', failure_evidence: { rule: 8, detail: 'the llm_judge grader failed: criteria c2 not met' } });
    await pool.query(`INSERT INTO judge_label (id, trial_id, grader_index, human_passed, labeler) VALUES ($1, $2, 0, true, 'author')`, [ulid(), trial.judged]);
    const r = await backfill(prisma, {});
    expect(r.updated).toBe(1);
    expect(await row(trial.judged)).toMatchObject({ failure_category: 'grader_disagreement', failure_evidence: { rule: 9, grader_index: 0 } });
    // and the label going the other way returns it
    await pool.query(`UPDATE judge_label SET human_passed = false WHERE trial_id = $1`, [trial.judged]);
    await backfill(prisma, {});
    expect((await row(trial.judged)).failure_category).toBe('judge_criteria_unmet');
  });

  it('flags the stop condition when more than half of the failures are wrong_answer', async () => {
    const r = await backfill(prisma, {});
    const text = formatReport({ ...r, wrongAnswerShare: 0.6 });
    expect(text).toContain('STOP CONDITION (card section 9)');
  });

  it('draws a reproducible sample per category for a person to read', async () => {
    const one = await backfill(prisma, { sample: 1, seed: 7 });
    const two = await backfill(prisma, { sample: 1, seed: 7 });
    expect(one.samples).toEqual(two.samples);
    expect(one.samples.wrong_answer).toHaveLength(1);
    expect(one.samples.step_exhaustion[0]).toMatchObject({ trialId: trial.maxsteps, category: 'step_exhaustion', exitReason: 'max_steps' });
    expect(one.samples.memory_ignored[0]).toMatchObject({ trialId: trial.ignored, eventSeq: 1, graderIndex: 0 });
    const all = await backfill(prisma, { sample: 5 });
    expect(all.samples.wrong_answer).toHaveLength(1); // fewer than asked: all of them
    expect(formatReport(all)).toContain('sample of memory_ignored:');
  });
});
