import { Global, Module } from '@nestjs/common';
import { Scheduler } from './scheduler';

/** Global, so ExperimentsService and AdhocService can inject the Scheduler without their modules importing this one. */
@Global()
@Module({ providers: [Scheduler], exports: [Scheduler] })
export class SchedulerModule {}
