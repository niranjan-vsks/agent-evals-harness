import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

const num = (d: { toNumber(): number } | null): number | null => (d ? d.toNumber() : null);

@Injectable()
export class TrialsQuery {
  constructor(private readonly prisma: PrismaService) {}

  private async graders(trialId: string) {
    const rows = await this.prisma.graderResult.findMany({ where: { trialId }, orderBy: { graderIndex: 'asc' } });
    return rows.map((g) => ({
      grader_index: g.graderIndex,
      grader_type: g.graderType,
      passed: g.passed,
      details: g.details,
      reasoning: g.reasoning,
      judge_model_id: g.judgeModelId,
      judge_prompt_hash: g.judgePromptHash,
      duration_ms: g.durationMs,
    }));
  }

  /** GET /trials/:id: the trial row with its grader results. */
  async trial(id: string) {
    const t = await this.prisma.trial.findUnique({ where: { id } });
    if (!t) throw new NotFoundException(`trial ${id} not found`);
    return {
      id: t.id,
      experiment_id: t.experimentId,
      config_id: t.configId,
      task_id: t.taskId,
      task_version_hash: t.taskVersionHash,
      trial_index: t.trialIndex,
      seed: t.seed,
      status: t.status,
      attempt_count: t.attemptCount,
      passed: t.passed,
      exit_reason: t.exitReason,
      steps: t.steps,
      input_tokens: t.inputTokens,
      output_tokens: t.outputTokens,
      cache_read_tokens: t.cacheReadTokens,
      reasoning_tokens: t.reasoningTokens,
      api_calls: t.apiCalls,
      latency_ms: t.latencyMs,
      cost_usd: num(t.costUsd),
      harness_cost_usd: num(t.harnessCostUsd),
      price_snapshot: t.priceSnapshot,
      rate_limit_events: t.rateLimitEvents,
      error_class: t.errorClass,
      error_message: t.errorMessage,
      failure_category: t.failureCategory,
      failure_evidence: t.failureEvidence,
      started_at: t.startedAt,
      ended_at: t.endedAt,
      grader_results: await this.graders(id),
    };
  }

  /** GET /trials/:id/trace: the stored trace with the grader results. An errored trial has only the partial events. */
  async trace(id: string) {
    const t = await this.prisma.trace.findUnique({ where: { trialId: id } });
    if (t) {
      return {
        trial_id: t.trialId,
        schema_version: t.schemaVersion,
        harness_id: t.harnessId,
        harness_version: t.harnessVersion,
        model_slug: t.modelSlug,
        system_prompt: t.systemPrompt,
        events: t.events,
        memory_initial: t.memoryInitial,
        memory_final: t.memoryFinal,
        skills_invoked: t.skillsInvoked,
        notes: t.notes,
        final_response: t.finalResponse,
        grader_results: await this.graders(id),
      };
    }
    const attempt = await this.prisma.trialAttempt.findFirst({ where: { trialId: id }, orderBy: { attemptNo: 'desc' } });
    if (!attempt) throw new NotFoundException(`trial ${id} not found`);
    return {
      trial_id: id,
      partial: true,
      events: attempt.partialTrace ?? [],
      error_class: attempt.errorClass,
      error_message: attempt.errorMessage,
      grader_results: [],
    };
  }

  /** POST /trials/adhoc response: the trial, its trace and the grader results. */
  async fullTrial(id: string) {
    const trial = await this.trial(id);
    const trace = await this.trace(id);
    return { trial, trace, grader_results: trial.grader_results };
  }
}
