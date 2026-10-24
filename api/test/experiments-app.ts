import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { Scheduler } from '../src/scheduler/scheduler';
import { FakeWorker } from '../src/test-support/app';
import { WorkerClient } from '../src/worker-client/worker-client';

/** A stand-in for the Scheduler whose calls a test can inspect; dispatch is not under test in the experiments slice. */
export function fakeScheduler() {
  return {
    kick: jest.fn(),
    cancelOnWorker: jest.fn(async (_trialIds: string[]) => undefined),
    resetBreaker: jest.fn((_experimentId: string) => undefined),
    clock: () => new Date(),
  };
}

export type FakeScheduler = ReturnType<typeof fakeScheduler>;

export async function createExperimentsApp(worker: FakeWorker = new FakeWorker()): Promise<{
  app: INestApplication;
  prisma: PrismaService;
  worker: FakeWorker;
  scheduler: FakeScheduler;
}> {
  const scheduler = fakeScheduler();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(WorkerClient)
    .useValue(worker)
    .overrideProvider(Scheduler)
    .useValue(scheduler)
    .compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  return { app, prisma: app.get(PrismaService), worker, scheduler };
}
