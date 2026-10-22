import { Module } from '@nestjs/common';
import { AdhocService } from './adhoc';
import { TrialsController } from './trials.controller';
import { TrialsQuery } from './trials.query';

@Module({ controllers: [TrialsController], providers: [AdhocService, TrialsQuery], exports: [TrialsQuery] })
export class TrialsModule {}
