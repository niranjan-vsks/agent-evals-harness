import { Injectable, NotFoundException, PipeTransform } from '@nestjs/common';

/**
 * Route :id guard. Postgres rejects a NUL byte in text (22021), which would surface as a 500; an id that
 * cannot exist is a 404 whatever it contains. Ids are ULIDs (26 characters), so 64 is generous.
 */
@Injectable()
export class ExperimentIdPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (typeof value !== 'string' || value.length === 0 || value.length > 64 || value.includes('\u0000')) {
      throw new NotFoundException('experiment not found');
    }
    return value;
  }
}
