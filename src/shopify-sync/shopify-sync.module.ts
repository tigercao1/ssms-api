import { Module } from '@nestjs/common';
import { RolesGuard } from '../admin/roles.guard';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { DocumentsModule } from '../documents/documents.module';
import { ShopifyModule } from '../shopify/shopify.module';
import {
  AdminGoLiveController,
  MeGoLiveController,
} from './go-live.controller';
import { GoLiveService } from './go-live.service';
import { InstructorPhotoSync } from './instructor-photo.sync';
import {
  InstructorSyncRepository,
  SupabaseInstructorSyncRepository,
} from './instructor-sync.repository';
import { InstructorSyncService } from './instructor-sync.service';
import { InstructorTranslationsSync } from './instructor-translations.sync';
import { LegacyRoster } from './legacy-roster';
import { ReconcileAuthGuard } from './reconcile-auth.guard';
import { ShopifySyncAdminController } from './shopify-sync-admin.controller';
import { ShopifySyncAdminService } from './shopify-sync-admin.service';
import {
  ShopifySyncSettingsRepository,
  SupabaseShopifySyncSettingsRepository,
} from './shopify-sync-settings.repository';
import { ShopifySyncSettings } from './shopify-sync-settings.service';
import { ShopifyInstructorGateway } from './shopify-instructor.gateway';
import { ShopifySyncController } from './shopify-sync.controller';
import { ShopifySyncWorker } from './shopify-sync.worker';

@Module({
  imports: [ShopifyModule, DocumentsModule],
  controllers: [
    ShopifySyncController,
    ShopifySyncAdminController,
    MeGoLiveController,
    AdminGoLiveController,
  ],
  providers: [
    {
      provide: InstructorSyncRepository,
      useClass: SupabaseInstructorSyncRepository,
    },
    {
      provide: ShopifySyncSettingsRepository,
      useClass: SupabaseShopifySyncSettingsRepository,
    },
    ShopifySyncSettings,
    ShopifySyncAdminService,
    ShopifyInstructorGateway,
    InstructorPhotoSync,
    InstructorTranslationsSync,
    LegacyRoster,
    GoLiveService,
    InstructorSyncService,
    ShopifySyncWorker,
    SupabaseAuthGuard,
    RolesGuard,
    ReconcileAuthGuard,
  ],
})
export class ShopifySyncModule {}
