import { Module } from '@nestjs/common';
import { CompareModule } from './compare/module';
import { ConfigsModule } from './configs/configs.module';
import { ExperimentsModule } from './experiments/module';
import { ExportModule } from './export/module';
import { HarnessesModule } from './harnesses/harnesses.module';
import { HealthController } from './health.controller';
import { ModelsModule } from './models/models.module';
import { PrismaModule } from './prisma/prisma.module';
import { SchedulerModule } from './scheduler/module';
import { SummaryModule } from './summary/summary.controller';
import { TasksModule } from './tasks/tasks.module';
import { TrialsModule } from './trials/trials.module';
import { WorkerClientModule } from './worker-client/worker-client.module';

@Module({
  imports: [PrismaModule, WorkerClientModule, ModelsModule, HarnessesModule, TasksModule, ConfigsModule, TrialsModule, SchedulerModule, ExperimentsModule, CompareModule, ExportModule, SummaryModule],
  controllers: [HealthController],
})
export class AppModule {}
