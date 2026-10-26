// Each test attempts the forbidden write and asserts the database rejects it (DATA_MODEL 4).
import type { Pool } from 'pg';
import { BaseRows, insertBaseRows, insertExperiment, insertTrial, newPool, sqlState } from '../test-support/db';
import { ulid } from '../common/ulid';

const CHECK_VIOLATION = '23514';
const UNIQUE_VIOLATION = '23505';
const INVALID_ENUM = '22P02';
const EVIDENCE = { rule: 10, category: 'wrong_answer', detail: 'fixture' };

describe('database invariants', () => {
  let pool: Pool;
  let base: BaseRows;

  beforeAll(() => {
    pool = newPool();
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    base = await insertBaseRows(pool);
  });

  it('stores UTF-8, because traces carry whatever characters the model printed', async () => {
    const enc = await pool.query(`SHOW server_encoding`);
    expect(enc.rows[0].server_encoding).toBe('UTF8');
    const exp = await insertExperiment(pool);
    const trialId = await insertTrial(pool, base, exp);
    await pool.query(
      `INSERT INTO trace (trial_id, harness_id, harness_version, model_slug, events, memory_initial, memory_final, skills_invoked, notes, final_response)
       VALUES ($1, 'h', 'v', 's', '[]', '{}', '{}', ARRAY[]::text[], ARRAY[]::text[], $2)`,
      [trialId, 'done ✓ 日本語 \u{1F600}'],
    );
    const back = await pool.query(`SELECT final_response FROM trace WHERE trial_id = $1`, [trialId]);
    expect(back.rows[0].final_response).toBe('done ✓ 日本語 \u{1F600}');
  });

  describe('D-1 states are enums', () => {
    it('rejects an undefined trial status', async () => {
      const exp = await insertExperiment(pool);
      const err = await sqlState(insertTrial(pool, base, exp, { status: 'half-done' }));
      expect(err?.code).toBe(INVALID_ENUM);
    });
  });

  describe('D-2 one current version per task id', () => {
    it('rejects a second is_current row for the same id', async () => {
      const err = await sqlState(
        pool.query(
          `INSERT INTO task (id, version_hash, category, prompt, graders, is_current)
           VALUES ($1, 'other-hash', 'honesty', 'p', '[{"type":"exact_match"}]', true)`,
          [base.taskId],
        ),
      );
      expect(err?.code).toBe(UNIQUE_VIOLATION);
    });

    it('allows a new current version once the old one is cleared, and keeps the old row', async () => {
      await pool.query(`UPDATE task SET is_current = false WHERE id = $1`, [base.taskId]);
      await pool.query(
        `INSERT INTO task (id, version_hash, category, prompt, graders, is_current)
         VALUES ($1, 'v2-hash', 'honesty', 'p2', '[{"type":"exact_match"}]', true)`,
        [base.taskId],
      );
      const rows = await pool.query(`SELECT version_hash, is_current FROM task WHERE id = $1 ORDER BY version_hash`, [base.taskId]);
      expect(rows.rowCount).toBe(2);
      expect(rows.rows.filter((r) => r.is_current)).toHaveLength(1);
    });
  });

  describe('D-3 configs are immutable', () => {
    it('an UPDATE changes 0 rows and leaves the row as it was', async () => {
      const res = await pool.query(`UPDATE config SET name = 'renamed', settings = '{"x":1}' WHERE id = $1`, [base.configId]);
      expect(res.rowCount).toBe(0);
      const after = await pool.query(`SELECT name, settings FROM config WHERE id = $1`, [base.configId]);
      expect(after.rows[0]).toEqual({ name: 'c', settings: {} });
    });
  });

  describe('trace is write-once', () => {
    it('an UPDATE changes 0 rows', async () => {
      const exp = await insertExperiment(pool);
      const trialId = await insertTrial(pool, base, exp);
      await pool.query(
        `INSERT INTO trace (trial_id, harness_id, harness_version, model_slug, events, memory_initial, memory_final, skills_invoked, notes)
         VALUES ($1, 'h', 'v', 's', '[]', '{}', '{}', ARRAY[]::text[], ARRAY[]::text[])`,
        [trialId],
      );
      const res = await pool.query(`UPDATE trace SET final_response = 'changed' WHERE trial_id = $1`, [trialId]);
      expect(res.rowCount).toBe(0);
    });
  });

  describe('D-8 completed is impossible with an errored trial', () => {
    it('rejects status = completed while an errored trial exists', async () => {
      const exp = await insertExperiment(pool, { status: 'running' });
      await insertTrial(pool, base, exp, { index: 0, status: 'done', passed: true, exitReason: 'completed' });
      await insertTrial(pool, base, exp, { index: 1, status: 'errored', errorClass: 'worker_crash' });
      const err = await sqlState(pool.query(`UPDATE experiment SET status = 'completed' WHERE id = $1`, [exp]));
      expect(err?.code).toBe(CHECK_VIOLATION);
      expect(err?.message).toContain('D-8');
      const status = await pool.query(`SELECT status FROM experiment WHERE id = $1`, [exp]);
      expect(status.rows[0].status).toBe('running');
    });

    it('allows partial with an errored trial, and completed when every trial is done', async () => {
      const exp = await insertExperiment(pool, { status: 'running' });
      await insertTrial(pool, base, exp, { index: 0, status: 'errored', errorClass: 'rate_limited' });
      await pool.query(`UPDATE experiment SET status = 'partial' WHERE id = $1`, [exp]);

      const ok = await insertExperiment(pool, { status: 'running' });
      await insertTrial(pool, base, ok, { index: 0, status: 'done', passed: false, exitReason: 'timeout', failureCategory: 'timeout', failureEvidence: EVIDENCE });
      await pool.query(`UPDATE experiment SET status = 'completed' WHERE id = $1`, [ok]);
    });
  });

  describe('D-9 n_trials only increases', () => {
    it('rejects a decrease and allows an increase', async () => {
      const exp = await insertExperiment(pool, { nTrials: 5 });
      const err = await sqlState(pool.query(`UPDATE experiment SET n_trials = 3 WHERE id = $1`, [exp]));
      expect(err?.code).toBe(CHECK_VIOLATION);
      expect(err?.message).toContain('D-9');
      await pool.query(`UPDATE experiment SET n_trials = 7 WHERE id = $1`, [exp]);
      const row = await pool.query(`SELECT n_trials FROM experiment WHERE id = $1`, [exp]);
      expect(row.rows[0].n_trials).toBe(7);
    });

    it('rejects n_trials below 1', async () => {
      const err = await sqlState(insertExperiment(pool, { nTrials: 0 }));
      expect(err?.code).toBe(CHECK_VIOLATION);
    });
  });

  describe('D-10 hypothesis and axis are immutable after draft', () => {
    it('allows edits in draft', async () => {
      const exp = await insertExperiment(pool, { hypothesis: 'h1', axis: 'a1' });
      await pool.query(`UPDATE experiment SET hypothesis = 'h2', axis = 'a2' WHERE id = $1`, [exp]);
    });

    it('rejects hypothesis and axis edits once status is not draft', async () => {
      const exp = await insertExperiment(pool, { status: 'queued', hypothesis: 'h1', axis: 'a1' });
      const h = await sqlState(pool.query(`UPDATE experiment SET hypothesis = 'changed' WHERE id = $1`, [exp]));
      expect(h?.code).toBe(CHECK_VIOLATION);
      expect(h?.message).toContain('D-10');
      const a = await sqlState(pool.query(`UPDATE experiment SET axis = 'changed' WHERE id = $1`, [exp]));
      expect(a?.code).toBe(CHECK_VIOLATION);
    });

    it('still allows other columns to change after draft', async () => {
      const exp = await insertExperiment(pool, { status: 'queued', hypothesis: 'h1' });
      await pool.query(`UPDATE experiment SET status = 'running', pause_reason = 'x' WHERE id = $1`, [exp]);
    });
  });

  describe('D-11 passed is set iff the trial is done', () => {
    it('rejects a done trial with passed NULL', async () => {
      const exp = await insertExperiment(pool);
      const err = await sqlState(insertTrial(pool, base, exp, { status: 'done', passed: null, exitReason: 'completed' }));
      expect(err?.code).toBe(CHECK_VIOLATION);
    });

    it('rejects a pending trial with passed set', async () => {
      const exp = await insertExperiment(pool);
      const err = await sqlState(insertTrial(pool, base, exp, { status: 'pending', passed: true }));
      expect(err?.code).toBe(CHECK_VIOLATION);
    });

    it('rejects a done trial without an exit_reason', async () => {
      const exp = await insertExperiment(pool);
      const err = await sqlState(insertTrial(pool, base, exp, { status: 'done', passed: true, exitReason: null }));
      expect(err?.code).toBe(CHECK_VIOLATION);
    });

    it('accepts a done trial with passed false', async () => {
      const exp = await insertExperiment(pool);
      await insertTrial(pool, base, exp, { status: 'done', passed: false, exitReason: 'max_steps', failureCategory: 'step_exhaustion', failureEvidence: EVIDENCE });
    });
  });

  describe('failure category (P6, 0003_failure_category)', () => {
    it('rejects a done, failed trial without a category, with a category but no evidence, and a passed trial with a category', async () => {
      const exp = await insertExperiment(pool);
      const none = await sqlState(insertTrial(pool, base, exp, { index: 0, status: 'done', passed: false, exitReason: 'completed' }));
      expect(none?.code).toBe(CHECK_VIOLATION);
      expect(none?.message).toContain('trial_failure_category_iff_failed');
      const noEvidence = await sqlState(insertTrial(pool, base, exp, { index: 1, status: 'done', passed: false, exitReason: 'completed', failureCategory: 'wrong_answer' }));
      expect(noEvidence?.code).toBe(CHECK_VIOLATION);
      expect(noEvidence?.message).toContain('trial_failure_evidence_iff_category');
      const passed = await sqlState(insertTrial(pool, base, exp, { index: 2, status: 'done', passed: true, exitReason: 'completed', failureCategory: 'wrong_answer', failureEvidence: EVIDENCE }));
      expect(passed?.code).toBe(CHECK_VIOLATION);
      expect(passed?.message).toContain('trial_failure_category_iff_failed');
    });

    it('rejects a category on a pending or errored trial, and accepts none on them and on a passed one', async () => {
      const exp = await insertExperiment(pool);
      const pending = await sqlState(insertTrial(pool, base, exp, { index: 0, status: 'pending', failureCategory: 'timeout', failureEvidence: EVIDENCE }));
      expect(pending?.code).toBe(CHECK_VIOLATION);
      const errored = await sqlState(insertTrial(pool, base, exp, { index: 1, status: 'errored', errorClass: 'worker_crash', failureCategory: 'timeout', failureEvidence: EVIDENCE }));
      expect(errored?.code).toBe(CHECK_VIOLATION);
      await insertTrial(pool, base, exp, { index: 2, status: 'pending' });
      await insertTrial(pool, base, exp, { index: 3, status: 'errored', errorClass: 'worker_crash' });
      await insertTrial(pool, base, exp, { index: 4, status: 'done', passed: true, exitReason: 'completed' });
    });

    it('only accepts the 12 categories', async () => {
      const exp = await insertExperiment(pool);
      const bad = await sqlState(insertTrial(pool, base, exp, { status: 'done', passed: false, exitReason: 'completed', failureCategory: 'because', failureEvidence: EVIDENCE }));
      expect(bad?.code).toBe(INVALID_ENUM); // not a label of the enum
      const labels = await pool.query(`SELECT unnest(enum_range(NULL::failure_category))::text AS label`);
      expect(labels.rows.map((r) => r.label)).toEqual([
        'step_exhaustion', 'timeout', 'hallucinated_tool_args', 'wrong_tool_usage', 'tool_error_unrecovered', 'no_final_answer', 'gave_up_early', 'judge_criteria_unmet', 'grader_disagreement', 'memory_ignored', 'abstained', 'wrong_answer',
      ]); // prettier-ignore
    });

    it('is validated on a database with no old failed trial (the migration validates it when nothing needs a backfill)', async () => {
      const r = await pool.query(`SELECT convalidated FROM pg_constraint WHERE conname = 'trial_failure_category_iff_failed'`);
      expect(r.rows).toEqual([{ convalidated: true }]);
    });
  });

  describe('D-12 one trial per (experiment, config, task, index)', () => {
    it('rejects a duplicate', async () => {
      const exp = await insertExperiment(pool);
      await insertTrial(pool, base, exp, { index: 0 });
      const err = await sqlState(insertTrial(pool, base, exp, { index: 0 }));
      expect(err?.code).toBe(UNIQUE_VIOLATION);
    });
  });

  describe('D-13 errored implies error_class', () => {
    it('rejects an errored trial without a class', async () => {
      const exp = await insertExperiment(pool);
      const err = await sqlState(insertTrial(pool, base, exp, { status: 'errored', errorClass: null }));
      expect(err?.code).toBe(CHECK_VIOLATION);
    });

    it('accepts an errored trial with a class', async () => {
      const exp = await insertExperiment(pool);
      await insertTrial(pool, base, exp, { status: 'errored', errorClass: 'provider_error' });
    });
  });

  describe('other column constraints', () => {
    it('rejects a task id that does not match the format', async () => {
      const err = await sqlState(
        pool.query(
          `INSERT INTO task (id, version_hash, category, prompt, graders) VALUES ('Bad_ID', 'h', 'honesty', 'p', '[{"type":"exact_match"}]')`,
        ),
      );
      expect(err?.code).toBe(CHECK_VIOLATION);
    });

    it('rejects a task with an empty graders array', async () => {
      const err = await sqlState(
        pool.query(`INSERT INTO task (id, version_hash, category, prompt, graders) VALUES ('tst-02-x', 'h', 'honesty', 'p', '[]')`),
      );
      expect(err?.code).toBe(CHECK_VIOLATION);
    });

    it('rejects a negative model price', async () => {
      const err = await sqlState(
        pool.query(
          `INSERT INTO model (id, display_name, slug, base_url, api_key_env, input_price_per_mtok, output_price_per_mtok, context_window, roles)
           VALUES ('neg', 'n', 'neg/slug', 'http://x', 'K', -1, 0, 10, ARRAY[]::text[])`,
        ),
      );
      expect(err?.code).toBe(CHECK_VIOLATION);
    });

    it('rejects a negative cached input price', async () => {
      const err = await sqlState(
        pool.query(
          `INSERT INTO model (id, display_name, slug, base_url, api_key_env, input_price_per_mtok, output_price_per_mtok, cached_input_price_per_mtok, context_window, roles)
           VALUES ('negc', 'n', 'negc/slug', 'http://x', 'K', 1, 1, -0.5, 10, ARRAY[]::text[])`,
        ),
      );
      expect(err?.code).toBe(CHECK_VIOLATION);
    });

    it('requires judge model and prompt hash exactly for llm_judge graders', async () => {
      const exp = await insertExperiment(pool);
      const trialId = await insertTrial(pool, base, exp);
      const bad = await sqlState(
        pool.query(
          `INSERT INTO grader_result (id, trial_id, grader_index, grader_type, passed, details, duration_ms)
           VALUES ($1, $2, 0, 'llm_judge', true, '{}', 1)`,
          [ulid(), trialId],
        ),
      );
      expect(bad?.code).toBe(CHECK_VIOLATION);
      await pool.query(
        `INSERT INTO grader_result (id, trial_id, grader_index, grader_type, passed, details, duration_ms)
         VALUES ($1, $2, 0, 'exact_match', true, '{}', 1)`,
        [ulid(), trialId],
      );
    });

    it('requires the attempt number to be unique per trial', async () => {
      const exp = await insertExperiment(pool);
      const trialId = await insertTrial(pool, base, exp);
      await pool.query(`INSERT INTO trial_attempt (id, trial_id, attempt_no) VALUES ($1, $2, 1)`, [ulid(), trialId]);
      const err = await sqlState(pool.query(`INSERT INTO trial_attempt (id, trial_id, attempt_no) VALUES ($1, $2, 1)`, [ulid(), trialId]));
      expect(err?.code).toBe(UNIQUE_VIOLATION);
    });
  });
});
