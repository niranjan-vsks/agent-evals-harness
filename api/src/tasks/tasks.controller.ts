import { Controller, Get, Post } from '@nestjs/common';
import { TasksService } from './tasks.service';

@Controller('tasks')
export class TasksController {
  constructor(private readonly tasks: TasksService) {}

  @Get()
  list() {
    return this.tasks.listCurrent();
  }

  @Post('sync')
  sync() {
    return this.tasks.sync();
  }
}
