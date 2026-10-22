import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';

const SeedRow = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  display_name: z.string().min(1),
  slug: z.string().min(1),
  base_url: z.string().url(),
  api_key_env: z.string().min(1),
  input_price_per_mtok: z.number().nonnegative(),
  output_price_per_mtok: z.number().nonnegative(),
  context_window: z.number().int().positive(),
  roles: z.array(z.enum(['candidate', 'judge'])),
});
export type ModelSeedRow = z.infer<typeof SeedRow>;

export function parseModelSeed(raw: unknown): ModelSeedRow[] {
  return z.array(SeedRow).parse(raw);
}

@Injectable()
export class ModelsService implements OnModuleInit {
  private readonly log = new Logger(ModelsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    await this.seed();
  }

  /** Upsert api/seed/models.json by id. Price edits are allowed; trial.price_snapshot protects history (D-7). */
  async seed(path = process.env.MODELS_SEED ?? join(process.cwd(), 'seed', 'models.json')): Promise<number> {
    const rows = parseModelSeed(JSON.parse(readFileSync(path, 'utf8')));
    for (const r of rows) {
      const data = {
        displayName: r.display_name,
        slug: r.slug,
        baseUrl: r.base_url,
        apiKeyEnv: r.api_key_env,
        inputPricePerMtok: r.input_price_per_mtok,
        outputPricePerMtok: r.output_price_per_mtok,
        contextWindow: r.context_window,
        roles: r.roles,
      };
      await this.prisma.model.upsert({ where: { id: r.id }, create: { id: r.id, ...data }, update: data });
    }
    this.log.log(`seeded ${rows.length} models from ${path}`);
    return rows.length;
  }

  async list() {
    const rows = await this.prisma.model.findMany({ orderBy: { id: 'asc' } });
    return rows.map((m) => ({
      id: m.id,
      display_name: m.displayName,
      slug: m.slug,
      base_url: m.baseUrl,
      api_key_env: m.apiKeyEnv,
      input_price_per_mtok: m.inputPricePerMtok.toNumber(),
      output_price_per_mtok: m.outputPricePerMtok.toNumber(),
      context_window: m.contextWindow,
      roles: m.roles,
      created_at: m.createdAt,
    }));
  }
}
