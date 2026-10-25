import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import { ulid } from '../common/ulid';

export function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set; run tests through `npm test`');
  return url;
}

export function newPool(): Pool {
  return new Pool({ connectionString: databaseUrl() });
}

export function newPrisma(): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl() }) });
}

/** Postgres error carrying a SQLSTATE `code` (node-postgres) or a Prisma-wrapped cause. */
export async function sqlState(promise: Promise<unknown>): Promise<{ code: string; message: string } | null> {
  try {
    await promise;
    return null;
  } catch (e) {
    const err = e as { code?: string; message?: string; cause?: { originalCode?: string; code?: string } };
    return {
      code: err.code ?? err.cause?.originalCode ?? err.cause?.code ?? 'unknown',
      message: err.message ?? String(e),
    };
  }
}

export interface BaseRows {
  modelId: string;
  harnessId: string;
  harnessVersion: string;
  configId: string;
  taskId: string;
  taskVersionHash: string;
}

let counter = 0;
function uniq(): string {
  counter += 1;
  return `${Date.now().toString(36)}${counter}${Math.random().toString(36).slice(2, 6)}`;
}

/** Inserts 1 model, harness, config and task with unique keys and returns their keys. */
export async function insertBaseRows(pool: Pool): Promise<BaseRows> {
  const suffix = uniq();
  const modelId = `m-${suffix}`;
  const harnessId = `h_${suffix.replace(/-/g, '_')}`;
  const harnessVersion = 'v1';
  const configId = ulid();
  const taskId = `tst-01-${suffix.replace(/[^a-z0-9]/g, '')}`;
  const taskVersionHash = `hash-${suffix}`;
  await pool.query(
    `INSERT INTO model (id, display_name, slug, base_url, api_key_env, input_price_per_mtok, output_price_per_mtok, context_window, roles)
     VALUES ($1, 'test', $2, 'http://x', 'KEY', 1, 2, 1000, ARRAY['candidate'])`,
    [modelId, `slug/${suffix}`],
  );
  await pool.query(`INSERT INTO harness (id, version, capabilities) VALUES ($1, $2, '{}')`, [harnessId, harnessVersion]);
  await pool.query(
    `INSERT INTO config (id, name, harness_id, harness_version, model_id, model_slug, settings, config_hash)
     VALUES ($1, 'c', $2, $3, $4, $5, '{}', $6)`,
    [configId, harnessId, harnessVersion, modelId, `slug/${suffix}`, `cfg-${suffix}`],
  );
  await pool.query(
    `INSERT INTO task (id, version_hash, category, prompt, graders, discriminates, tags, is_current)
     VALUES ($1, $2, 'neutral_deterministic', 'p', '[{"type":"exact_match"}]', ARRAY['model'], ARRAY[]::text[], true)`,
    [taskId, taskVersionHash],
  );
  return { modelId, harnessId, harnessVersion, configId, taskId, taskVersionHash };
}

export async function insertExperiment(
  pool: Pool,
  fields: { status?: string; nTrials?: number; hypothesis?: string | null; axis?: string | null } = {},
): Promise<string> {
  const id = ulid();
  await pool.query(
    `INSERT INTO experiment (id, name, status, n_trials, seed, phase, axis, hypothesis, worker_manifest)
     VALUES ($1, 'e', $2::experiment_status, $3, 1, 'full', $4, $5, '{}')`,
    [id, fields.status ?? 'draft', fields.nTrials ?? 3, fields.axis ?? null, fields.hypothesis ?? null],
  );
  return id;
}

export async function insertTrial(
  pool: Pool,
  base: BaseRows,
  experimentId: string,
  fields: {
    index?: number;
    status?: string;
    passed?: boolean | null;
    exitReason?: string | null;
    errorClass?: string | null;
    /** A done, failed trial needs both (CHECK trial_failure_category_iff_failed). */
    failureCategory?: string | null;
    failureEvidence?: object | null;
  } = {},
): Promise<string> {
  const id = ulid();
  await pool.query(
    `INSERT INTO trial (id, experiment_id, config_id, task_id, task_version_hash, trial_index, seed, status, passed, exit_reason, error_class, failure_category, failure_evidence, price_snapshot)
     VALUES ($1, $2, $3, $4, $5, $6, 1, $7::trial_status, $8, $9::exit_reason, $10::error_class, $11::failure_category, $12::jsonb, '{"input_price_per_mtok":1,"output_price_per_mtok":2}')`,
    [
      id,
      experimentId,
      base.configId,
      base.taskId,
      base.taskVersionHash,
      fields.index ?? 0,
      fields.status ?? 'pending',
      fields.passed ?? null,
      fields.exitReason ?? null,
      fields.errorClass ?? null,
      fields.failureCategory ?? null,
      fields.failureEvidence === undefined || fields.failureEvidence === null ? null : JSON.stringify(fields.failureEvidence),
    ],
  );
  return id;
}
