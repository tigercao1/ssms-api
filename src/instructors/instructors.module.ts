import { Module } from '@nestjs/common';
import { BioTranslationModule } from '../bio-translation/bio-translation.module';
import { TranslationQueueService } from '../bio-translation/translation-queue.service';
import { InstructorsController } from './instructors.controller';
import { InstructorsService } from './instructors.service';
import {
  InstructorsRepository,
  SupabaseInstructorsRepository,
} from './instructors.repository';
import { TRANSLATION_QUEUE } from './translation-queue.port';

/**
 * InstructorsModule — self-service profile (`/me/instructor`) + the reusable
 * transactional update logic (exported via InstructorsService for the Admin
 * module, A4 / T6.6).
 *
 * Depends on the global DatabaseModule (SUPABASE_CLIENT) and AuthModule guards.
 * The repository is bound behind the abstract `InstructorsRepository` token so
 * tests can swap in an in-memory fake. TRANSLATION_QUEUE is bound to the real
 * BioTranslation `TranslationQueueService` (T5.2) so the profile save flow
 * enqueues bio translations via `enqueueForProfile`.
 */
@Module({
  imports: [BioTranslationModule],
  controllers: [InstructorsController],
  providers: [
    InstructorsService,
    { provide: InstructorsRepository, useClass: SupabaseInstructorsRepository },
    { provide: TRANSLATION_QUEUE, useExisting: TranslationQueueService },
  ],
  exports: [InstructorsService],
})
export class InstructorsModule {}
