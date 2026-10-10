import { Module } from '@nestjs/common';
import { RolesGuard } from '../admin/roles.guard';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { ShopifyModule } from '../shopify/shopify.module';
import { InstructorPhotoSync } from './instructor-photo.sync';
import {
  InstructorSyncRepository,
  SupabaseInstructorSyncRepository,
} from './instructor-sync.repository';
import { InstructorSyncService } from './instructor-sync.service';
import { InstructorTranslationsSync } from './instructor-translations.sync';
import { ReconcileAuthGuard } from './reconcile-auth.guard';
import { ShopifyInstructorGateway } from './shopify-instructor.gateway';
import { ShopifySyncController } from './shopify-sync.controller';
import { ShopifySyncWorker } from './shopify-sync.worker';

@Module({
  imports: [ShopifyModule],
  controllers: [ShopifySyncController],
  providers: [
    {
      provide: InstructorSyncRepository,
      useClass: SupabaseInstructorSyncRepository,
    },
    ShopifyInstructorGateway,
    InstructorPhotoSync,
    InstructorTranslationsSync,
    InstructorSyncService,
    ShopifySyncWorker,
    SupabaseAuthGuard,
    RolesGuard,
    ReconcileAuthGuard,
  ],
})
export class ShopifySyncModule {}
