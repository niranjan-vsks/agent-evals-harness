import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { defaultTasksDir, loadTasks } from './load-tasks';

export interface SyncResult {
  tasks_on_disk: number;
  new_versions: string[];
  retired: string[];
  memory_fixtures: number;
  errors: string[];
}

@Injectable()
export class TasksService implements OnModuleInit {
  private readonly log = new Logger(TasksService.name);
  private lock: Promise<unknown> = Promise.resolve();

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    try {
      const r = await this.sync();
      this.log.log(`synced ${r.tasks_on_disk} tasks (${r.new_versions.length} new versions), ${r.memory_fixtures} memory fixtures`);
      for (const e of r.errors) this.log.error(e);
    } catch (e) {
      this.log.error(`task sync failed: ${(e as Error).message}`);
    }
  }

  /** Serialized: the one-current-version index (D-2) must never see 2 syncs interleave. */
  sync(tasksDir: string = defaultTasksDir()): Promise<SyncResult> {
    const run = this.lock.then(() => this.doSync(tasksDir));
    this.lock = run.catch(() => undefined);
    return run;
  }

  private async doSync(tasksDir: string): Promise<SyncResult> {
    const { tasks, memoryFixtures, errors } = loadTasks(tasksDir);
    const newVersions: string[] = [];

    for (const fx of memoryFixtures) {
      await this.prisma.memoryFixture.upsert({
        where: { name_hash: { name: fx.name, hash: fx.hash } },
        create: { name: fx.name, hash: fx.hash, files: fx.files },
        update: {},
      });
    }

    for (const t of tasks) {
      const d = t.data;
      await this.prisma.$transaction(async (tx) => {
        const key = { id_versionHash: { id: d.id, versionHash: t.versionHash } };
        if (!(await tx.task.findUnique({ where: key }))) {
          await tx.task.create({
            data: {
              id: d.id,
              versionHash: t.versionHash,
              category: d.category,
              prompt: d.prompt,
              fixtureDir: d.fixture_dir,
              memoryFixture: d.memory_fixture,
              graders: d.graders as object[],
              discriminates: d.discriminates,
              tags: d.tags,
              isCurrent: false,
            },
          });
          newVersions.push(`${d.id}@${t.versionHash.slice(0, 12)}`);
        }
        // Clear the old flag before setting the new one: the partial unique index is immediate.
        await tx.task.updateMany({
          where: { id: d.id, isCurrent: true, NOT: { versionHash: t.versionHash } },
          data: { isCurrent: false },
        });
        await tx.task.update({ where: key, data: { isCurrent: true } });
      });
    }

    const onDisk = tasks.map((t) => t.data.id);
    const retiredRows = await this.prisma.task.findMany({
      where: { isCurrent: true, id: { notIn: onDisk } },
      select: { id: true },
    });
    if (retiredRows.length) {
      await this.prisma.task.updateMany({ where: { isCurrent: true, id: { notIn: onDisk } }, data: { isCurrent: false } });
    }
    return {
      tasks_on_disk: tasks.length,
      new_versions: newVersions,
      retired: retiredRows.map((r) => r.id),
      memory_fixtures: memoryFixtures.length,
      errors,
    };
  }

  async listCurrent() {
    const rows = await this.prisma.task.findMany({ where: { isCurrent: true }, orderBy: { id: 'asc' } });
    return rows.map((t) => ({
      id: t.id,
      version_hash: t.versionHash,
      category: t.category,
      prompt: t.prompt,
      fixture_dir: t.fixtureDir,
      memory_fixture: t.memoryFixture,
      graders: t.graders,
      discriminates: t.discriminates,
      tags: t.tags,
    }));
  }
}
