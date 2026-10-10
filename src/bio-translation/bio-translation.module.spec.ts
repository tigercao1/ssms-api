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
      createBioTranslator(config({ GEMINI_API_KEY: '  ' })),
    ).toBeInstanceOf(StubBioTranslator);
  });

  it('binds Gemini with GEMINI_MODEL when the key is set', () => {
    const translator = createBioTranslator(
      config({ GEMINI_API_KEY: 'k', GEMINI_MODEL: 'gemini-custom' }),
    );
    expect(translator).toBeInstanceOf(GeminiBioTranslator);
    expect(translator.modelId).toBe('gemini-custom');
  });

  it('defaults the Gemini model', () => {
    expect(createBioTranslator(config({ GEMINI_API_KEY: 'k' })).modelId).toBe(
      DEFAULT_GEMINI_MODEL,
    );
  });
});
