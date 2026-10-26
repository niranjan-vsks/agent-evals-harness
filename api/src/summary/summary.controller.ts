import { Controller, Get, Module } from '@nestjs/common';
import { SummaryService } from './summary.service';

@Controller('summary')
export class SummaryController {
  constructor(private readonly summary: SummaryService) {}

  /** GET /summary: read-only, the home dashboard's numbers (cards/P8.md section 4). */
  @Get()
  get() {
    return this.summary.summary();
  }
}

@Module({ controllers: [SummaryController], providers: [SummaryService] })
export class SummaryModule {}
