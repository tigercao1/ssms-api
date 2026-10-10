import { Module } from '@nestjs/common';
import { ShopifyModule } from '../shopify/shopify.module';
import {
  InstructorSyncRepository,
  SupabaseInstructorSyncRepository,
} from './instructor-sync.repository';
import { InstructorPhotoSync } from './instructor-photo.sync';
import { InstructorSyncService } from './instructor-sync.service';
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
    InstructorSyncService,
  ],
  exports: [InstructorSyncService],
})
export class ShopifySyncModule {}
