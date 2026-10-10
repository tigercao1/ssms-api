import { Inject, Injectable, Logger } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../database/supabase-client.token';
import type { BioLang } from './bio-translator.interface';
import type {
  BioChange,
  BioState,
  TranslationJobPlan,
} from './bio-translation-job.types';

const BIO_JOBS_TABLE = 'bio_translation_jobs';

/** True when a bio field holds no usable content (null / blank). */
function isEmptyBio(value: string | null | undefined): boolean {
  return value == null || value.trim().length === 0;
}

function textOf(state: BioState, lang: BioLang): string {
  return ((lang === 'en' ? state.bioEn : state.bioZh) ?? '').trim();
}

function isMachineTranslated(state: BioState, lang: BioLang): boolean {
  return lang === 'en'
    ? state.bioEnMachineTranslated
    : state.bioZhMachineTranslated;
}

function isHumanEdit(change: BioChange, lang: BioLang): boolean {
  return (
    textOf(change.before, lang) !== textOf(change.after, lang) &&
    !isMachineTranslated(change.after, lang)
  );
}

/**
 * Decides which translation job (if any) a profile save should enqueue.
 *
 * Translate language S into T when S was edited by a human in this save and T
 * is empty or machine-translated. Human text in T is never overwritten, and a
 * save that edits both languages enqueues nothing. Names are never translated.
 *
 * Pure + exported so it can be unit-tested without a DB.
 */
export function planTranslationJob(
  change: BioChange,
): TranslationJobPlan | null {
  const enEdited = isHumanEdit(change, 'en');
  const zhEdited = isHumanEdit(change, 'zh-CN');
  if (enEdited === zhEdited) {
    return null;
  }

  const sourceLang: BioLang = enEdited ? 'en' : 'zh-CN';
  const targetLang: BioLang = enEdited ? 'zh-CN' : 'en';
  const sourceText = textOf(change.after, sourceLang);
  const target = textOf(change.after, targetLang);
  if (
    isEmptyBio(sourceText) ||
    !(isEmptyBio(target) || isMachineTranslated(change.after, targetLang))
  ) {
    return null;
  }

  return {
    instructorId: change.instructorId,
    sourceLang,
    targetLang,
    sourceText,
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
   * Enqueues a translation job for the just-saved profile when
   * {@link planTranslationJob} asks for one. Supersedes any outstanding job for
   * the same instructor and direction so that re-editing the source
   * re-translates from the latest text.
   *
   * @returns `true` if a job was enqueued, `false` otherwise.
   */
  async enqueueForProfile(change: BioChange): Promise<boolean> {
    const plan = planTranslationJob(change);
    if (!plan) {
      return false;
    }

    try {
      // Invalidate outstanding jobs for this instructor + direction so a source
      // re-edit re-translates from the newest text (keeps the unique index sat).
      const { error: clearError } = await this.supabase
        .from(BIO_JOBS_TABLE)
        .delete()
        .eq('instructor_id', plan.instructorId)
        .eq('target_lang', plan.targetLang)
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
