/**
 * Fixtures for the compare and pilot specs, on top of test/helpers.ts (which stays untouched). Every row a spec
 * creates is tracked so `cleanup` removes exactly it: the specs share one database.
 */
import { ulid } from '../src/common/ulid';
import { FailureCategory } from '../src/failures/rules';
import { Prisma, PrismaClient } from '../src/generated/prisma/client';
import { judgePolicy } from '../src/judge/policy';
import { Fixtures } from './helpers';

export type TaskCategoryName = 'memory_dependent' | 'memory_distractor' | 'neutral_deterministic' | 'neutral_judged' | 'honesty';

export const JUDGE_GRADER = { type: 'llm_judge', rubric: 'rubric', question: 'q' };
export const EXACT_GRADER = { type: 'exact_match', expected: '8081' };

/** Every key name found at any depth of a JSON value. */
export function keysDeep(value: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) value.forEach((v) => keysDeep(v, out));
  else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      keysDeep(v, out);
    }
  }
  return out;
}

export class CompareFixtures {
  validationIds: string[] = [];

  constructor(
    readonly prisma: PrismaClient,
    readonly fx: Fixtures,
  ) {}

  /** A current task of the given category; tracked by `fx`, so fx.cleanup removes it. */
  async task(id: string, category: TaskCategoryName, graders: unknown[]): Promise<void> {
    await this.prisma.task.create({
      data: { id, versionHash: `hash-${id}`, category, prompt: `prompt of ${id}`, graders: graders as never, discriminates: ['model'], tags: [], isCurrent: true },
    });
    this.fx.taskIds.push(id);
  }

  /** A trial finished the way the scheduler would leave it. */
  async done(trialId: string, passed: boolean, over: { costUsd?: number; latencyMs?: number; failureCategory?: FailureCategory } = {}): Promise<void> {
    const category = passed ? null : (over.failureCategory ?? 'wrong_answer');
    await this.prisma.trial.update({
      where: { id: trialId },
      data: {
        status: 'done',
        passed,
        // The CHECK of 0003_failure_category: a failed done trial carries its category and evidence from the same UPDATE.
        failureCategory: category,
        failureEvidence: category ? { rule: 10, category, detail: 'fixture' } : Prisma.DbNull,
        exitReason: 'completed',
        steps: 2,
        inputTokens: 3000,
        outputTokens: 40,
        latencyMs: over.latencyMs ?? 1000,
        costUsd: over.costUsd ?? 0.01,
        attemptCount: 1,
        startedAt: new Date(),
        endedAt: new Date(),
      },
    });
  }

  async errored(trialId: string): Promise<void> {
    await this.prisma.trial.update({
      where: { id: trialId },
      data: { status: 'errored', errorClass: 'worker_crash', errorMessage: 'scripted', attemptCount: 3, endedAt: new Date() },
    });
  }

  async cancelled(trialId: string): Promise<void> {
    await this.prisma.trial.update({ where: { id: trialId }, data: { status: 'cancelled', errorClass: 'cancelled', errorMessage: 'cancelled', endedAt: new Date() } });
  }

  /** llm_judge grader rows (grader_index 0) tagged with the judge, for trials that have none yet. */
  async judgeRows(trialIds: string[], modelId: string, promptHash: string): Promise<void> {
    await this.prisma.graderResult.createMany({
      data: trialIds.map((trialId) => ({
        id: ulid(),
        trialId,
        graderIndex: 0,
        graderType: 'llm_judge' as const,
        passed: true,
        details: {},
        judgeModelId: modelId,
        judgePromptHash: promptHash,
        durationMs: 1,
      })),
    });
  }

  /** A judge_validation row; the policy column follows the kappa unless `policy` says otherwise (to prove it is re-derived). */
  async validation(v: { modelId: string; promptHash: string; kappa: number; computedAt?: Date; policy?: 'trusted' | 'flagged' | 'excluded' }): Promise<string> {
    const id = ulid();
    await this.prisma.judgeValidation.create({
      data: {
        id,
        computedAt: v.computedAt ?? new Date(),
        judgeModelId: v.modelId,
        judgePromptHash: v.promptHash,
        labelSetHash: 'x'.repeat(64),
        nItems: 30,
        agreementRaw: 0.9,
        kappa: v.kappa,
        kappaCiLow: Math.max(-1, v.kappa - 0.1),
        kappaCiHigh: Math.min(1, v.kappa + 0.1),
        policy: v.policy ?? judgePolicy(v.kappa),
      },
    });
    this.validationIds.push(id);
    return id;
  }

  /** Experiment ids this spec created, including the ones made through the API (the caller pushes those onto fx.experimentIds). */
  async cleanup(): Promise<void> {
    await this.prisma.comparisonRun.deleteMany({ where: { experimentId: { in: this.fx.experimentIds } } });
    await this.prisma.judgeValidation.deleteMany({ where: { id: { in: this.validationIds } } });
    await this.fx.cleanup();
  }
}
