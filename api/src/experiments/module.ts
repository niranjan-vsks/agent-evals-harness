import { Module } from '@nestjs/common';
import { ExperimentsController } from './controller';
import { ExperimentsService } from './service';

@Module({ controllers: [ExperimentsController], providers: [ExperimentsService], exports: [ExperimentsService] })
export class ExperimentsModule {}
