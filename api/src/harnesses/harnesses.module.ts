import { Module } from '@nestjs/common';
import { HarnessesController } from './harnesses.controller';
import { HarnessesService } from './harnesses.service';

@Module({ controllers: [HarnessesController], providers: [HarnessesService], exports: [HarnessesService] })
export class HarnessesModule {}
