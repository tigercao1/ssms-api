import { Injectable, Logger } from '@nestjs/common';
import type {
  BioTranslationInput,
  BioTranslator,
} from './bio-translator.interface';

/**
 * v1 placeholder translator. Resolves to `''` and logs a warning so it is
 * obvious in the logs that no real provider is wired yet.
 *
 * Per BIO_TRANSLATION_PLAN.md this keeps profile saves working: the missing
 * language simply stays empty and the public API falls back to the other
 * language per locale rules. `bio_<lang>_machine_translated` stays false.
 */
@Injectable()
export class StubBioTranslator implements BioTranslator {
  private readonly logger = new Logger(StubBioTranslator.name);

  translate(input: BioTranslationInput): Promise<string> {
    this.logger.warn(
      `BioTranslator stub invoked (${input.from} -> ${input.to}); ` +
        'no AI provider wired in v1 — returning empty translation.',
    );
    return Promise.resolve('');
  }
}
