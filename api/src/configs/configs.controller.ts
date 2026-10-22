import { All, Body, Controller, Get, HttpException, HttpStatus, Param, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ConfigsService } from './configs.service';

@Controller('configs')
export class ConfigsController {
  constructor(private readonly configs: ConfigsService) {}

  /** 201 with the new config, 200 with the existing one when the content hash already exists. */
  @Post()
  async create(@Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const { created, config } = await this.configs.create(body);
    res.status(created ? 201 : 200);
    return config;
  }

  @Get()
  list() {
    return this.configs.list();
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.configs.get(id);
  }

  /** D-3: configs are immutable. There is no update endpoint, only an explicit refusal. */
  @All([':id', ''])
  immutable() {
    throw new HttpException(
      { message: 'configs are immutable; create a new config instead (POST /configs)' },
      HttpStatus.METHOD_NOT_ALLOWED,
    );
  }
}
