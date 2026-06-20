import { Module } from '@nestjs/common';
import { BIO_TRANSLATOR } from './bio-translator.interface';
import { StubBioTranslator } from './stub-bio-translator';
import { TranslationQueueService } from './translation-queue.service';
import { TranslationWorkerService } from './translation-worker.service';

/**
 * Bio AI translation (BIO_TRANSLATION_PLAN.md).
 *
 * v1 binds {@link BIO_TRANSLATOR} to the {@link StubBioTranslator}. To ship a
 * real provider post-v1, swap this one `useClass` — no other code changes.
 *
 * DatabaseModule is @Global, so SUPABASE_CLIENT is injectable without import.
 * Exports the queue service so the instructor-profile save flow can enqueue.
 */
@Module({
  providers: [
    { provide: BIO_TRANSLATOR, useClass: StubBioTranslator },
    TranslationQueueService,
    TranslationWorkerService,
  ],
  exports: [TranslationQueueService, TranslationWorkerService],
})
export class BioTranslationModule {}
