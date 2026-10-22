import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { TasksService } from './tasks.service';

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const result = await app.get(TasksService).sync();
  console.log(JSON.stringify(result, null, 2));
  await app.close();
  if (result.errors.length) process.exit(1);
}
void main();
