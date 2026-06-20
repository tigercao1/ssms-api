import type { BioLang } from './bio-translator.interface';

/** Lifecycle of a {@link BioTranslationJob} row (mirrors the SQL check). */
export type BioTranslationJobStatus =
  | 'pending'
  | 'processing'
  | 'completed'
  | 'skipped'
  | 'failed';

/** DB row shape for `bio_translation_jobs` (snake_case as stored). */
export interface BioTranslationJobRow {
  id: string;
  instructor_id: string;
  source_lang: BioLang;
  target_lang: BioLang;
  source_text: string;
  status: BioTranslationJobStatus;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  run_after: string;
  inserted_at: string;
  updated_at: string;
}

/** Bio fields as supplied by a profile save, used to decide enqueueing. */
export interface BioSnapshot {
  instructorId: string;
  bioEn?: string | null;
  bioZh?: string | null;
}

/** A single translation to enqueue (source -> target). */
export interface TranslationJobPlan {
  instructorId: string;
  sourceLang: BioLang;
  targetLang: BioLang;
  sourceText: string;
}
