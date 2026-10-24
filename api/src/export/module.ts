import { Module } from '@nestjs/common';
import { CompareModule } from '../compare/module';
import { ExportController } from './controller';
import { ExportService } from './service';

@Module({ imports: [CompareModule], controllers: [ExportController], providers: [ExportService] })
export class ExportModule {}
