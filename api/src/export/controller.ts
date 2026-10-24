import { Controller, Get, Param, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ExperimentIdPipe } from '../experiments/id-pipe';
import { ExportService } from './service';

const CSV = 'text/csv; charset=utf-8';

/** A filename-safe stem: experiment ids are ULIDs, but the id comes from the URL. */
const stem = (id: string) => id.replace(/[^A-Za-z0-9_-]/g, '_');

@Controller('experiments')
export class ExportController {
  constructor(private readonly exports: ExportService) {}

  @Get(':id/export.json')
  async json(@Param('id', ExperimentIdPipe) id: string, @Query() q: Record<string, unknown>, @Res({ passthrough: true }) res: Response) {
    const body = await this.exports.json(id, q);
    res.setHeader('Content-Disposition', `attachment; filename="experiment-${stem(id)}.json"`);
    return body;
  }

  @Get(':id/export.csv')
  async trials(@Param('id', ExperimentIdPipe) id: string, @Res({ passthrough: true }) res: Response) {
    const csv = await this.exports.trialsCsv(id);
    res.setHeader('Content-Type', CSV);
    res.setHeader('Content-Disposition', `attachment; filename="experiment-${stem(id)}.csv"`);
    return csv;
  }

  @Get(':id/compare.csv')
  async compare(@Param('id', ExperimentIdPipe) id: string, @Query() q: Record<string, unknown>, @Res({ passthrough: true }) res: Response) {
    const csv = await this.exports.compareCsv(id, q);
    res.setHeader('Content-Type', CSV);
    res.setHeader('Content-Disposition', `attachment; filename="compare-${stem(id)}.csv"`);
    return csv;
  }
}
