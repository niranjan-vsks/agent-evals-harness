import { resolve } from 'node:path';

/** experiments/ at the repo root: EXPERIMENTS_DIR in compose (a bind mount), ../experiments from api/ on a host. */
export function experimentsDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.EXPERIMENTS_DIR ?? resolve(process.cwd(), '..', 'experiments');
}

export function judgeValidationDir(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(experimentsDir(env), 'judge-validation');
}

export const SAMPLE_FILE = 'sample.jsonl';
export const LABELS_FILE = 'labels.jsonl';
