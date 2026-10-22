import { Controller, Get } from '@nestjs/common';
import { HarnessesService } from './harnesses.service';

@Controller('harnesses')
export class HarnessesController {
  constructor(private readonly harnesses: HarnessesService) {}

  @Get()
  list() {
    return this.harnesses.list();
  }
}
