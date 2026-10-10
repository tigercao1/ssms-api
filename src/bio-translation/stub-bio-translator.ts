import { Injectable, Logger } from '@nestjs/common';
import type {
  BioTranslationInput,
  BioTranslator,
} from './bio-translator.interface';

/**
 * Placeholder translator bound unless translation is enabled with a Gemini key.
 * Resolves to `''` and logs a warning so it is obvious no provider is wired.
 *
 * Per BIO_TRANSLATION_PLAN.md this keeps profile saves working: the missing
 * language simply stays empty and the public API falls back to the other
 * language per locale rules. `bio_<lang>_machine_translated` stays false.
 */
@Injectable()
export class StubBioTranslator implements BioTranslator {
  private readonly logger = new Logger(StubBioTranslator.name);
  readonly modelId = null;

  translate(input: BioTranslationInput): Promise<string> {
    this.logger.warn(
      `BioTranslator stub invoked (${input.from} -> ${input.to}); ` +
        'translation is disabled — returning empty translation.',
    );
    return Promise.resolve('');
  }
}
