import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { ModelsModule } from './models/models.module';
import { PrismaModule } from './prisma/prisma.module';
import { TasksModule } from './tasks/tasks.module';

@Module({
  imports: [PrismaModule, ModelsModule, TasksModule],
  controllers: [HealthController],
})
export class AppModule {}
