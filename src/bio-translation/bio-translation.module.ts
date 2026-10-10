import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BIO_TRANSLATOR } from './bio-translator.interface';
import type { BioTranslator } from './bio-translator.interface';
import { GeminiBioTranslator } from './gemini-bio-translator';
import { StubBioTranslator } from './stub-bio-translator';
import { TranslationQueueService } from './translation-queue.service';
import { TranslationWorkerService } from './translation-worker.service';

export function createBioTranslator(config: ConfigService): BioTranslator {
  const apiKey = config.get<string>('GEMINI_API_KEY')?.trim();
  if (!apiKey) {
    return new StubBioTranslator();
  }
  return new GeminiBioTranslator({
    apiKey,
    model: config.get<string>('GEMINI_MODEL'),
  });
}

/**
 * Bio AI translation (BIO_TRANSLATION_PLAN.md).
 *
 * {@link BIO_TRANSLATOR} is the Gemini provider when `GEMINI_API_KEY` is set
 * and the {@link StubBioTranslator} otherwise.
 *
 * DatabaseModule is @Global, so SUPABASE_CLIENT is injectable without import.
 * Exports the queue service so the instructor-profile save flow can enqueue.
 */
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: BIO_TRANSLATOR,
      useFactory: createBioTranslator,
      inject: [ConfigService],
    },
    TranslationQueueService,
    TranslationWorkerService,
  ],
  exports: [TranslationQueueService, TranslationWorkerService, BIO_TRANSLATOR],
})
export class BioTranslationModule {}
