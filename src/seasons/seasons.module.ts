import { Module } from '@nestjs/common';
import {
  SeasonsRepository,
  SupabaseSeasonsRepository,
} from './seasons.repository';
import { SeasonsService } from './seasons.service';

@Module({
  providers: [
    { provide: SeasonsRepository, useClass: SupabaseSeasonsRepository },
    SeasonsService,
  ],
  exports: [SeasonsService],
})
export class SeasonsModule {}
