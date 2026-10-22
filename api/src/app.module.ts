import { Module } from '@nestjs/common';
import { ConfigsModule } from './configs/configs.module';
import { HarnessesModule } from './harnesses/harnesses.module';
import { HealthController } from './health.controller';
import { ModelsModule } from './models/models.module';
import { PrismaModule } from './prisma/prisma.module';
import { TasksModule } from './tasks/tasks.module';
import { TrialsModule } from './trials/trials.module';
import { WorkerClientModule } from './worker-client/worker-client.module';

@Module({
  imports: [PrismaModule, WorkerClientModule, ModelsModule, HarnessesModule, TasksModule, ConfigsModule, TrialsModule],
  controllers: [HealthController],
})
export class AppModule {}
