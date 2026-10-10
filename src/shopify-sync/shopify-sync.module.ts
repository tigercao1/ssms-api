import { Module } from '@nestjs/common';
import { ShopifyModule } from '../shopify/shopify.module';
import {
  InstructorSyncRepository,
  SupabaseInstructorSyncRepository,
} from './instructor-sync.repository';
import { InstructorPhotoSync } from './instructor-photo.sync';
import { InstructorSyncService } from './instructor-sync.service';
import { InstructorTranslationsSync } from './instructor-translations.sync';
import { ShopifyInstructorGateway } from './shopify-instructor.gateway';

@Module({
  imports: [ShopifyModule],
  providers: [
    {
      provide: InstructorSyncRepository,
      useClass: SupabaseInstructorSyncRepository,
    },
    ShopifyInstructorGateway,
    InstructorPhotoSync,
    InstructorTranslationsSync,
    InstructorSyncService,
  ],
  exports: [InstructorSyncService],
})
export class ShopifySyncModule {}
