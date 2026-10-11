import { isEmailLanguage, resolveEmailLanguage } from './email-language';

describe('resolveEmailLanguage', () => {
  it('uses the instructor preferred_language when it is supported', () => {
    expect(resolveEmailLanguage('en')).toBe('en');
    expect(resolveEmailLanguage('zh-CN')).toBe('zh-CN');
  });

  it('falls back to bilingual when there is no language', () => {
    expect(resolveEmailLanguage(null)).toBe('bilingual');
    expect(resolveEmailLanguage(undefined)).toBe('bilingual');
    expect(resolveEmailLanguage('fr')).toBe('bilingual');
  });
});

describe('isEmailLanguage', () => {
  it('accepts en, zh-CN and bilingual only', () => {
    expect(isEmailLanguage('en')).toBe(true);
    expect(isEmailLanguage('zh-CN')).toBe(true);
    expect(isEmailLanguage('bilingual')).toBe(true);
    expect(isEmailLanguage('zh')).toBe(false);
    expect(isEmailLanguage(undefined)).toBe(false);
  });
});
