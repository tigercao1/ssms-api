import { Inject, Injectable, Logger } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../database/supabase-client.token';
import type {
  BioSnapshot,
  TranslationJobPlan,
} from './bio-translation-job.types';

const BIO_JOBS_TABLE = 'bio_translation_jobs';

/** True when a bio field holds no usable content (null / blank). */
function isEmptyBio(value: string | null | undefined): boolean {
  return value == null || value.trim().length === 0;
}

/**
 * Decides which translation job (if any) a profile save should enqueue.
 *
 * Per BIO_TRANSLATION_PLAN.md: enqueue **only when exactly one** of the two
 * bios is non-empty and the other is empty — translate the present one into
 * the missing one. If both or neither are filled, there is nothing to do.
 *
 * Pure + exported so it can be unit-tested without a DB.
 */
export function planTranslationJob(
  snapshot: BioSnapshot,
): TranslationJobPlan | null {
  const enFilled = !isEmptyBio(snapshot.bioEn);
  const zhFilled = !isEmptyBio(snapshot.bioZh);

  if (enFilled === zhFilled) {
    // both filled, or both empty — nothing to translate.
    return null;
  }

  if (enFilled) {
    return {
      instructorId: snapshot.instructorId,
      sourceLang: 'en',
      targetLang: 'zh-CN',
      sourceText: snapshot.bioEn!.trim(),
    };
  }

  return {
    instructorId: snapshot.instructorId,
    sourceLang: 'zh-CN',
    targetLang: 'en',
    sourceText: snapshot.bioZh!.trim(),
  };
}

/**
 * Async bio-translation queue (T5.2 scaffold).
 *
 * `enqueueForProfile` is called by the instructor-profile save flow AFTER the
 * row is persisted. It never throws into the caller: a queue hiccup must not
 * fail the profile save (BIO_TRANSLATION_PLAN.md § Failure handling), so it
 * returns whether a job was enqueued and logs problems instead.
 *
 * A background worker (TranslationWorkerService) drains the table.
 */
@Injectable()
export class TranslationQueueService {
  private readonly logger = new Logger(TranslationQueueService.name);

  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
  ) {}

  /**
   * Enqueues a translation job for the just-saved profile if exactly one bio
   * language is filled. Supersedes any still-pending job for the instructor so
   * that re-editing the source re-translates from the latest text.
   *
   * @returns `true` if a job was enqueued, `false` otherwise.
   */
  async enqueueForProfile(snapshot: BioSnapshot): Promise<boolean> {
    const plan = planTranslationJob(snapshot);
    if (!plan) {
      return false;
    }

    try {
      // Invalidate any outstanding job for this instructor so a source re-edit
      // re-translates from the newest text (keeps the partial-unique index sat).
      const { error: clearError } = await this.supabase
        .from(BIO_JOBS_TABLE)
        .delete()
        .eq('instructor_id', plan.instructorId)
        .in('status', ['pending', 'processing']);
      if (clearError) {
        throw new Error(clearError.message);
      }

      const { error: insertError } = await this.supabase
        .from(BIO_JOBS_TABLE)
        .insert({
          instructor_id: plan.instructorId,
          source_lang: plan.sourceLang,
          target_lang: plan.targetLang,
          source_text: plan.sourceText,
        });
      if (insertError) {
        throw new Error(insertError.message);
      }

      return true;
    } catch (err) {
      // Never propagate: profile save already succeeded.
      this.logger.error(
        `Failed to enqueue bio translation for instructor ` +
          `${plan.instructorId}: ${(err as Error).message}`,
      );
      return false;
    }
  }
}
