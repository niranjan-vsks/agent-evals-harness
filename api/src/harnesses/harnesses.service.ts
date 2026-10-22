import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { WorkerClient } from '../worker-client/worker-client';
import { WorkerManifest } from '../worker-client/types';

@Injectable()
export class HarnessesService implements OnModuleInit {
  private readonly log = new Logger(HarnessesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly worker: WorkerClient,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      const manifest = await this.refresh();
      this.log.log(`recorded ${manifest.adapters.map((a) => `${a.id}@${a.version}`).join(', ') || 'no adapters'}`);
    } catch (e) {
      // Not fatal: the worker may start after the API. Config creation retries.
      this.log.warn(`could not read the worker manifest at boot: ${(e as Error).message}`);
    }
  }

  /** GET worker /adapters and upsert 1 row per (id, version). Old versions are never deleted: configs reference them. */
  async refresh(): Promise<WorkerManifest> {
    const manifest = await this.worker.adapters();
    for (const a of manifest.adapters) {
      await this.prisma.harness.upsert({
        where: { id_version: { id: a.id, version: a.version } },
        create: { id: a.id, version: a.version, capabilities: a.capabilities as object },
        update: { capabilities: a.capabilities as object },
      });
    }
    return manifest;
  }

  async list() {
    const rows = await this.prisma.harness.findMany({ orderBy: [{ id: 'asc' }, { recordedAt: 'desc' }] });
    return rows.map((h) => ({ id: h.id, version: h.version, capabilities: h.capabilities, recorded_at: h.recordedAt }));
  }
}
