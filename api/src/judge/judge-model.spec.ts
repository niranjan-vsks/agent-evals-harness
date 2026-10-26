import { ConflictException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { DEFAULT_JUDGE_MODEL_ID, judgeModelId, needsJudge, resolveJudgeModel } from './judge-model';

const ROW = {
  id: 'model-a',
  slug: 'vendor/judge',
  baseUrl: 'https://example.test/v1',
  apiKeyEnv: 'SOME_KEY',
  inputPricePerMtok: new Prisma.Decimal('0.1'),
  outputPricePerMtok: new Prisma.Decimal('0.5'),
  cachedInputPricePerMtok: new Prisma.Decimal('0.01'),
  contextWindow: 1000,
  roles: ['candidate', 'judge'],
};

function fakePrisma(row: Partial<typeof ROW> | null): PrismaService {
  return { model: { findUnique: async ({ where }: { where: { id: string } }) => (row && where.id === (row.id ?? ROW.id) ? { ...ROW, ...row } : null) } } as unknown as PrismaService;
}

const JUDGED = [{ type: 'exact_match', expected: 'x' }, { type: 'llm_judge', rubric: [], inputs: [], pass_rule: 'all' }];

describe('judge model resolution', () => {
  it('reads JUDGE_MODEL_ID and defaults to model-a', () => {
    expect(judgeModelId({ JUDGE_MODEL_ID: 'model-b' })).toBe('model-b');
    expect(judgeModelId({})).toBe(DEFAULT_JUDGE_MODEL_ID);
    expect(judgeModelId({ JUDGE_MODEL_ID: '' })).toBe(DEFAULT_JUDGE_MODEL_ID);
  });

  it('is needed exactly when a grader is llm_judge', () => {
    expect(needsJudge(JUDGED)).toBe(true);
    expect(needsJudge([{ type: 'exact_match' }, { type: 'file_state' }])).toBe(false);
    expect(needsJudge([])).toBe(false);
  });

  it('returns null for a task with no judge, without touching the registry', async () => {
    const prisma = { model: { findUnique: () => Promise.reject(new Error('must not be called')) } } as unknown as PrismaService;
    await expect(resolveJudgeModel(prisma, [{ type: 'exact_match' }], {})).resolves.toBeNull();
  });

  it('returns the registry row as a ModelSpec, with numeric prices', async () => {
    const spec = await resolveJudgeModel(fakePrisma({}), JUDGED, { JUDGE_MODEL_ID: 'model-a' });
    expect(spec).toEqual({
      id: 'model-a',
      slug: 'vendor/judge',
      base_url: 'https://example.test/v1',
      api_key_env: 'SOME_KEY',
      input_price_per_mtok: 0.1,
      output_price_per_mtok: 0.5,
      cached_input_price_per_mtok: 0.01,
      context_window: 1000,
    });
  });

  it('refuses a missing row, a row without the judge role, and a task that names another judge', async () => {
    await expect(resolveJudgeModel(fakePrisma(null), JUDGED, { JUDGE_MODEL_ID: 'model-a' })).rejects.toBeInstanceOf(ConflictException);
    await expect(resolveJudgeModel(fakePrisma({ roles: ['candidate'] }), JUDGED, { JUDGE_MODEL_ID: 'model-a' })).rejects.toThrow('judge role');
    const named = [{ type: 'llm_judge', judge_model_id: 'model-b' }];
    await expect(resolveJudgeModel(fakePrisma({}), named, { JUDGE_MODEL_ID: 'model-a' })).rejects.toThrow('names judge model model-b');
  });
});
