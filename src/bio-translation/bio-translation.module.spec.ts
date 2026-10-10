import { ConfigService } from '@nestjs/config';
import { createBioTranslator } from './bio-translation.module';
import {
  DEFAULT_GEMINI_MODEL,
  GeminiBioTranslator,
} from './gemini-bio-translator';
import { StubBioTranslator } from './stub-bio-translator';

function config(values: Record<string, string>): ConfigService {
  return new ConfigService(values);
}

describe('createBioTranslator', () => {
  it('binds the stub when GEMINI_API_KEY is absent or blank', () => {
    expect(createBioTranslator(config({}))).toBeInstanceOf(StubBioTranslator);
    expect(
      createBioTranslator(
        config({ GEMINI_API_KEY: '  ', TRANSLATION_ENABLED: 'true' }),
      ),
    ).toBeInstanceOf(StubBioTranslator);
  });

  it.each([
    [{ GEMINI_API_KEY: 'k' }],
    [{ GEMINI_API_KEY: 'k', TRANSLATION_ENABLED: 'false' }],
    [{ GEMINI_API_KEY: 'k', TRANSLATION_ENABLED: 'TRUE' }],
  ])('binds the stub unless TRANSLATION_ENABLED is "true" (%j)', (env) => {
    expect(createBioTranslator(config(env))).toBeInstanceOf(StubBioTranslator);
  });

  it('binds Gemini with GEMINI_MODEL when enabled and the key is set', () => {
    const translator = createBioTranslator(
      config({
        GEMINI_API_KEY: 'k',
        GEMINI_MODEL: 'gemini-custom',
        TRANSLATION_ENABLED: 'true',
      }),
    );
    expect(translator).toBeInstanceOf(GeminiBioTranslator);
    expect(translator.modelId).toBe('gemini-custom');
  });

  it('defaults the Gemini model', () => {
    expect(
      createBioTranslator(
        config({ GEMINI_API_KEY: 'k', TRANSLATION_ENABLED: 'true' }),
      ).modelId,
    ).toBe(DEFAULT_GEMINI_MODEL);
  });
});
