import {
  isEmailLanguage,
  resolveEmailLanguage,
  withPortalLanguage,
} from './email-language';

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

describe('withPortalLanguage', () => {
  it('adds lang for en and zh-CN, keeping the query and fragment', () => {
    expect(withPortalLanguage('https://app.ssnow.club/login', 'en')).toBe(
      'https://app.ssnow.club/login?lang=en',
    );
    expect(
      withPortalLanguage('https://app.ssnow.club/activate?t=abc#top', 'zh-CN'),
    ).toBe('https://app.ssnow.club/activate?t=abc&lang=zh-CN#top');
  });

  it('replaces an existing lang', () => {
    expect(
      withPortalLanguage('https://app.ssnow.club/login?lang=en', 'zh-CN'),
    ).toBe('https://app.ssnow.club/login?lang=zh-CN');
  });

  it('removes lang for bilingual, keeping the other params and fragment', () => {
    expect(
      withPortalLanguage('https://app.ssnow.club/login?lang=en', 'bilingual'),
    ).toBe('https://app.ssnow.club/login');
    expect(
      withPortalLanguage(
        'https://app.ssnow.club/activate?t=abc&lang=zh-CN&next=%2Fhome#top',
        'bilingual',
      ),
    ).toBe('https://app.ssnow.club/activate?t=abc&next=%2Fhome#top');
    expect(
      withPortalLanguage('https://app.ssnow.club/login?t=abc', 'bilingual'),
    ).toBe('https://app.ssnow.club/login?t=abc');
  });

  it('leaves unparseable URLs unchanged', () => {
    expect(withPortalLanguage('', 'en')).toBe('');
    expect(withPortalLanguage('/login', 'en')).toBe('/login');
    expect(withPortalLanguage('', 'bilingual')).toBe('');
    expect(withPortalLanguage('/login?lang=en', 'bilingual')).toBe(
      '/login?lang=en',
    );
  });
});
