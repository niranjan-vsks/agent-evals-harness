import {
  BadRequestException,
  HttpException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { ulid } from '../common/ulid';
import { HarnessesService } from '../harnesses/harnesses.service';
import { PrismaService } from '../prisma/prisma.service';
import { WorkerClient, WorkerUnavailableError } from '../worker-client/worker-client';
import { ConfigBody, configHash, normalizeSettings } from './config-input';

export interface ConfigJson {
  id: string;
  name: string;
  harness_id: string;
  harness_version: string;
  model_id: string;
  model_slug: string;
  settings: unknown;
  config_hash: string;
  created_at: Date;
}

function toJson(c: {
  id: string;
  name: string;
  harnessId: string;
  harnessVersion: string;
  modelId: string;
  modelSlug: string;
  settings: unknown;
  configHash: string;
  createdAt: Date;
}): ConfigJson {
  return {
    id: c.id,
    name: c.name,
    harness_id: c.harnessId,
    harness_version: c.harnessVersion,
    model_id: c.modelId,
    model_slug: c.modelSlug,
    settings: c.settings,
    config_hash: c.configHash,
    created_at: c.createdAt,
  };
}

@Injectable()
export class ConfigsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly worker: WorkerClient,
    private readonly harnesses: HarnessesService,
  ) {}

  /**
   * Idempotent create. Resolves the model, the harness version the worker reports now and the
   * memory fixture's content hash (D-5), refuses anything the adapter cannot honor exactly
   * (D-4, H-1), then stores the row under its content hash. The same content under another
   * name returns the existing row (D-3).
   */
  async create(body: unknown): Promise<{ created: boolean; config: ConfigJson }> {
    const parsed = ConfigBody.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: 'invalid config body',
        issues: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
      });
    }
    const input = parsed.data;

    const model = await this.prisma.model.findUnique({ where: { id: input.model_id } });
    if (!model) throw new UnprocessableEntityException({ message: 'config refused', reasons: [`model ${input.model_id} is not in the registry`] });

    let harnessVersion: string;
    try {
      const manifest = await this.harnesses.refresh();
      const adapter = manifest.adapters.find((a) => a.id === input.harness_id);
      if (!adapter) {
        throw new UnprocessableEntityException({ message: 'config refused', reasons: [`harness ${input.harness_id} is not registered on the worker`] });
      }
      harnessVersion = adapter.version;
    } catch (e) {
      if (e instanceof HttpException) throw e;
      throw new ServiceUnavailableException(`worker unavailable: ${(e as Error).message}`);
    }

    let fixtureHash: string | null = null;
    if (input.settings.memory.mode === 'seeded' && input.settings.memory.fixture) {
      const fixture = await this.prisma.memoryFixture.findFirst({
        where: { name: input.settings.memory.fixture },
        orderBy: { syncedAt: 'desc' },
      });
      if (!fixture) {
        throw new UnprocessableEntityException({
          message: 'config refused',
          reasons: [`memory fixture ${input.settings.memory.fixture} has not been synced from tasks/memory/`],
        });
      }
      fixtureHash = fixture.hash;
    }

    const settings = normalizeSettings(input.settings, fixtureHash);

    let reasons: string[];
    try {
      reasons = await this.worker.validate(input.harness_id, settings);
    } catch (e) {
      if (e instanceof WorkerUnavailableError) throw new ServiceUnavailableException(e.message);
      throw e;
    }
    if (reasons.length) throw new UnprocessableEntityException({ message: 'config refused: the harness cannot honor these settings exactly', reasons });

    const hash = configHash({ harness_id: input.harness_id, harness_version: harnessVersion, model_slug: model.slug, settings });
    const existing = await this.prisma.config.findUnique({ where: { configHash: hash } });
    if (existing) return { created: false, config: toJson(existing) };

    try {
      const row = await this.prisma.config.create({
        data: {
          id: ulid(),
          name: input.name,
          harnessId: input.harness_id,
          harnessVersion,
          modelId: model.id,
          modelSlug: model.slug,
          settings: settings as unknown as Prisma.InputJsonValue,
          configHash: hash,
        },
      });
      return { created: true, config: toJson(row) };
    } catch (e) {
      // A concurrent identical create won the race on config_hash UNIQUE: that is the idempotent case.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const winner = await this.prisma.config.findUnique({ where: { configHash: hash } });
        if (winner) return { created: false, config: toJson(winner) };
      }
      throw e;
    }
  }

  async list(): Promise<ConfigJson[]> {
    return (await this.prisma.config.findMany({ orderBy: { createdAt: 'asc' } })).map(toJson);
  }

  async get(id: string): Promise<ConfigJson> {
    const row = await this.prisma.config.findUnique({ where: { id } });
    if (!row) throw new NotFoundException(`config ${id} not found`);
    return toJson(row);
  }
}
