import { ConflictException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ModelSpecJson } from '../worker-client/types';

/** The judge is a registry row with role "judge", chosen by JUDGE_MODEL_ID (DESIGN 8.1). */
export const DEFAULT_JUDGE_MODEL_ID = 'model-a';

export function judgeModelId(env: NodeJS.ProcessEnv = process.env): string {
  return env.JUDGE_MODEL_ID && env.JUDGE_MODEL_ID.length > 0 ? env.JUDGE_MODEL_ID : DEFAULT_JUDGE_MODEL_ID;
}

export function needsJudge(graders: unknown[]): boolean {
  return graders.some((g) => typeof g === 'object' && g !== null && (g as { type?: unknown }).type === 'llm_judge');
}

/**
 * The ModelSpec a TrialSpec carries for its llm_judge graders, or null when the task has none.
 * A task that names its own judge_model_id must name the configured one: a trial carries 1 judge.
 */
export async function resolveJudgeModel(prisma: PrismaService, graders: unknown[], env: NodeJS.ProcessEnv = process.env): Promise<ModelSpecJson | null> {
  if (!needsJudge(graders)) return null;
  const id = judgeModelId(env);
  for (const g of graders) {
    const named = (g as { judge_model_id?: string | null }).judge_model_id;
    if ((g as { type?: string }).type === 'llm_judge' && named != null && named !== id) {
      throw new ConflictException(`the task names judge model ${named} but JUDGE_MODEL_ID is ${id}`);
    }
  }
  const m = await prisma.model.findUnique({ where: { id } });
  if (!m) throw new ConflictException(`JUDGE_MODEL_ID ${id} is not in the model registry`);
  if (!m.roles.includes('judge')) throw new ConflictException(`model ${id} does not have the judge role`);
  return {
    id: m.id,
    slug: m.slug,
    base_url: m.baseUrl,
    api_key_env: m.apiKeyEnv,
    input_price_per_mtok: m.inputPricePerMtok.toNumber(),
    output_price_per_mtok: m.outputPricePerMtok.toNumber(),
    cached_input_price_per_mtok: m.cachedInputPricePerMtok.toNumber(),
    context_window: m.contextWindow,
  };
}
