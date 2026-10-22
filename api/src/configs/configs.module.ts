import { Module } from '@nestjs/common';
import { HarnessesModule } from '../harnesses/harnesses.module';
import { ConfigsController } from './configs.controller';
import { ConfigsService } from './configs.service';

@Module({ imports: [HarnessesModule], controllers: [ConfigsController], providers: [ConfigsService], exports: [ConfigsService] })
export class ConfigsModule {}
