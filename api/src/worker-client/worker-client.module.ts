import { Global, Module } from '@nestjs/common';
import { WorkerClient } from './worker-client';

@Global()
@Module({ providers: [WorkerClient], exports: [WorkerClient] })
export class WorkerClientModule {}
