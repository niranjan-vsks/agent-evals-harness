import { createHash } from 'node:crypto';

/** DATA_MODEL 2.6: trial seed = hash(seed, config_id, task_id, trial_index), as a non-negative int32. */
export function trialSeed(experimentSeed: number, configId: string, taskId: string, trialIndex: number): number {
  const digest = createHash('sha256').update(`${experimentSeed}:${configId}:${taskId}:${trialIndex}`, 'utf8').digest();
  return digest.readUInt32BE(0) & 0x7fffffff;
}
