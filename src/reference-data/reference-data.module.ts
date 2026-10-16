import { Module } from '@nestjs/common';
import { SeasonsModule } from '../seasons/seasons.module';
import { ReferenceDataController } from './reference-data.controller';
import { ReferenceDataService } from './reference-data.service';

/**
 * Read endpoints for admin-managed reference (lookup) tables.
 * DatabaseModule is @Global, so SUPABASE_CLIENT is injectable without import.
 */
@Module({
  imports: [SeasonsModule],
  controllers: [ReferenceDataController],
  providers: [ReferenceDataService],
  exports: [ReferenceDataService],
})
export class ReferenceDataModule {}
