import { Controller, Get, Param, Query } from '@nestjs/common';
import { ExperimentIdPipe } from '../experiments/id-pipe';
import { CompareService } from './service';

@Controller('experiments')
export class CompareController {
  constructor(private readonly compare: CompareService) {}

  @Get(':id/compare')
  compareConfigs(@Param('id', ExperimentIdPipe) id: string, @Query() q: { a?: string; b?: string; persist?: string }) {
    return this.compare.compute(id, q);
  }

  @Get(':id/pilot')
  pilot(@Param('id', ExperimentIdPipe) id: string) {
    return this.compare.pilot(id);
  }
}
