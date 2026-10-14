/**
 * Bio AI Translation — contract (see BIO_TRANSLATION_PLAN.md).
 *
 * BioTranslationModule binds {@link BIO_TRANSLATOR} to Gemini when translation
 * is enabled and `GEMINI_API_KEY` is set, else the stub — no call sites change.
 */

/** ISO-ish language codes used across the bio fields. */
export type BioLang = 'en' | 'zh-CN';

export type TranslationKind = 'bio' | 'reference-name';

export interface BioTranslationInput {
  text: string;
  from: BioLang;
  to: BioLang;
  kind?: TranslationKind;
  timeoutMs?: number;
}

export type BioDraftMode = 'refine' | 'translate';

export interface BioDraftInput {
  text: string;
  mode: BioDraftMode;
  /** Upper bound on each output language, in characters. */
  maxLength: number;
}

export interface BioDraft {
  en: string;
  zh: string;
  /** Languages present in the input text; non-empty. */
  sourceLangs: BioLang[];
}

/**
 * The single contract any translation provider must fulfil.
 *
 * Implementations MUST be side-effect free with respect to the caller: they
 * receive source text and resolve to translated text. Persisting the result
 * and toggling `bio_<lang>_machine_translated` is the queue's job, not the
 * translator's.
 */
export interface BioTranslator {
  readonly modelId: string | null;

  /**
   * Resolves to the translated text. The stub resolves to `''`, which the
   * queue treats as "leave the target field empty"; a real provider rejects
   * instead of resolving empty.
   */
  translate(input: BioTranslationInput): Promise<string>;

  /**
   * One call that returns the bio in both languages (instructor refine /
   * translate). Absent when no real provider is configured.
   */
  draft?(input: BioDraftInput): Promise<BioDraft>;
}

/**
 * DI token for the active {@link BioTranslator}. Inject with
 * `@Inject(BIO_TRANSLATOR)`. Swap the binding to drop in a real provider.
 */
export const BIO_TRANSLATOR = Symbol('BIO_TRANSLATOR');
