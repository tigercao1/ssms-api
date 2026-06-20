import { StubBioTranslator } from './stub-bio-translator';

describe('StubBioTranslator', () => {
  it('resolves to an empty string (no provider wired in v1)', async () => {
    const translator = new StubBioTranslator();

    const result = await translator.translate({
      text: 'I love teaching skiing.',
      from: 'en',
      to: 'zh-CN',
    });

    expect(result).toBe('');
  });
});
