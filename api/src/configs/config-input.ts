import { z } from 'zod';
import { createHash } from 'node:crypto';
import { canonicalJson } from '../common/canonical-json';
import { SettingsJson } from '../worker-client/types';

/** POST /configs body (DESIGN 5). The fixture hash is not accepted from the caller: it is resolved (D-5). */
export const ConfigBody = z
  .object({
    name: z.string().min(1),
    harness_id: z.string().regex(/^[a-z0-9_]+$/),
    model_id: z.string().min(1),
    settings: z
      .object({
        tools: z.array(z.enum(['shell', 'files'])),
        memory: z.object({ mode: z.enum(['off', 'seeded']), fixture: z.string().nullish() }).strict(),
        skills: z.object({ enabled: z.boolean(), preload: z.array(z.string()) }).strict().default({ enabled: false, preload: [] }),
        temperature: z.number().finite(),
        max_steps: z.number().int().positive(),
        max_output_tokens: z.number().int().positive(),
        timeout_seconds: z.number().int().positive(),
        harness_options: z.record(z.string(), z.unknown()).default({}),
      })
      .strict(),
  })
  .strict();

export type ConfigBodyData = z.infer<typeof ConfigBody>;

/**
 * The settings exactly as stored and hashed: tools is a set, so it is de-duplicated and sorted
 * (the same configuration written in another order is the same config), and the memory block
 * always has all 3 fields.
 */
export function normalizeSettings(input: ConfigBodyData['settings'], fixtureHash: string | null): SettingsJson {
  return {
    tools: [...new Set(input.tools)].sort(),
    memory: { mode: input.memory.mode, fixture: input.memory.fixture ?? null, fixture_hash: fixtureHash },
    skills: { enabled: input.skills.enabled, preload: [...input.skills.preload] },
    temperature: input.temperature,
    max_steps: input.max_steps,
    max_output_tokens: input.max_output_tokens,
    timeout_seconds: input.timeout_seconds,
    harness_options: normalizeHarnessOptions(input.harness_options),
  };
}

/** providers_ignored is a set of provider names: the same list in another order, or with a repeat, is the same config. */
function normalizeHarnessOptions(options: Record<string, unknown>): Record<string, unknown> {
  const ignored = options.providers_ignored;
  if (Array.isArray(ignored) && ignored.every((v) => typeof v === 'string')) {
    return { ...options, providers_ignored: [...new Set(ignored as string[])].sort() };
  }
  return options;
}

/** DATA_MODEL 2.5: sha256(canonical JSON of {harness_id, harness_version, model_slug, settings}). */
export function configHash(parts: { harness_id: string; harness_version: string; model_slug: string; settings: SettingsJson }): string {
  return createHash('sha256').update(canonicalJson(parts), 'utf8').digest('hex');
}
