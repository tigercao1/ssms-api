/**
 * Bio AI Translation — contract (see BIO_TRANSLATION_PLAN.md).
 *
 * v1 ships a STUB implementation only. The real provider (OpenAI / Anthropic /
 * DeepL / self-hosted) is wired post-v1 by binding a different implementation
 * to {@link BIO_TRANSLATOR} in the NestJS DI container — no call sites change.
 */

/** ISO-ish language codes used across the bio fields. */
export type BioLang = 'en' | 'zh-CN';

export interface BioTranslationInput {
  text: string;
  from: BioLang;
  to: BioLang;
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
  /**
   * Resolves to the translated text. A provider that cannot translate (e.g.
   * the v1 stub, or a transient outage surfaced as empty) resolves to `''`;
   * the queue treats an empty result as "leave the target field empty".
   */
  translate(input: BioTranslationInput): Promise<string>;
}

/**
 * DI token for the active {@link BioTranslator}. Inject with
 * `@Inject(BIO_TRANSLATOR)`. Swap the binding to drop in a real provider.
 */
export const BIO_TRANSLATOR = Symbol('BIO_TRANSLATOR');
