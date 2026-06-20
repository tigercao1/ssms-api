import { Module } from '@nestjs/common';
import { InstructorsModule } from '../instructors/instructors.module';
import { MediaController } from './media.controller';
import { MediaService } from './media.service';
import { STORAGE_CLIENT, SupabaseStorageClient } from './storage-client';

/**
 * MediaModule — instructor profile-photo uploads (T3.5). v1 is photos only;
 * private documents / e-signature are deferred (DOCUMENT_STORAGE_PLAN.md).
 *
 * Imports InstructorsModule to reuse the transactional profile-update path when
 * persisting the avatar URL. The storage backend is bound behind STORAGE_CLIENT
 * so tests can swap in a fake (TESTING_STRATEGY.md § Storage).
 */
@Module({
  imports: [InstructorsModule],
  controllers: [MediaController],
  providers: [
    MediaService,
    { provide: STORAGE_CLIENT, useClass: SupabaseStorageClient },
  ],
  exports: [MediaService],
})
export class MediaModule {}
