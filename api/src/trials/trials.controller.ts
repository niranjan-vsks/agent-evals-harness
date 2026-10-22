import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { AdhocService } from './adhoc';
import { TrialsQuery } from './trials.query';

@Controller('trials')
export class TrialsController {
  constructor(
    private readonly queries: TrialsQuery,
    private readonly adhoc: AdhocService,
  ) {}

  /** Registered before :id so "adhoc" is never read as a trial id. */
  @Post('adhoc')
  runAdhoc(@Body() body: unknown) {
    return this.adhoc.run(body);
  }

  @Get(':id')
  trial(@Param('id') id: string) {
    return this.queries.trial(id);
  }

  @Get(':id/trace')
  trace(@Param('id') id: string) {
    return this.queries.trace(id);
  }
}
