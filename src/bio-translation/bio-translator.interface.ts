/**
 * Bio AI Translation — contract (see BIO_TRANSLATION_PLAN.md).
 *
 * BioTranslationModule binds {@link BIO_TRANSLATOR} to the Gemini provider when
 * `GEMINI_API_KEY` is set, and to the stub otherwise — no call sites change.
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
}

/**
 * DI token for the active {@link BioTranslator}. Inject with
 * `@Inject(BIO_TRANSLATOR)`. Swap the binding to drop in a real provider.
 */
export const BIO_TRANSLATOR = Symbol('BIO_TRANSLATOR');
