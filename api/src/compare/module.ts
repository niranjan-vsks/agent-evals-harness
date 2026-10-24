import { Module } from '@nestjs/common';
import { CompareController } from './controller';
import { CompareService } from './service';

@Module({ controllers: [CompareController], providers: [CompareService], exports: [CompareService] })
export class CompareModule {}
