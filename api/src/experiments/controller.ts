import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ExperimentIdPipe } from './id-pipe';
import { ExperimentsService } from './service';

@Controller('experiments')
export class ExperimentsController {
  constructor(private readonly experiments: ExperimentsService) {}

  @Post()
  create(@Body() body: unknown) {
    return this.experiments.create(body);
  }

  @Get()
  list() {
    return this.experiments.list();
  }

  @Get(':id')
  get(@Param('id', ExperimentIdPipe) id: string) {
    return this.experiments.get(id);
  }

  @Get(':id/trials')
  trials(@Param('id', ExperimentIdPipe) id: string, @Query() q: unknown) {
    return this.experiments.trials(id, q);
  }

  @Post(':id/start')
  @HttpCode(200)
  start(@Param('id', ExperimentIdPipe) id: string) {
    return this.experiments.start(id);
  }

  @Post(':id/extend')
  @HttpCode(200)
  extend(@Param('id', ExperimentIdPipe) id: string, @Body() body: unknown) {
    return this.experiments.extend(id, body);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  cancel(@Param('id', ExperimentIdPipe) id: string) {
    return this.experiments.cancel(id);
  }

  @Post(':id/resume')
  @HttpCode(200)
  resume(@Param('id', ExperimentIdPipe) id: string) {
    return this.experiments.resume(id);
  }

  /** Creates a new draft, so 201. */
  @Post(':id/reproduce')
  reproduce(@Param('id', ExperimentIdPipe) id: string, @Body() body: unknown) {
    return this.experiments.reproduce(id, body);
  }
}
