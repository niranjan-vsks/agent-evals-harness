import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { ModelsModule } from './models/models.module';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [PrismaModule, ModelsModule],
  controllers: [HealthController],
})
export class AppModule {}
