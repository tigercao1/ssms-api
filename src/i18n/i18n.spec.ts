import {
  catalogs,
  en,
  getCatalog,
  isSupportedLanguage,
  resolveLanguage,
  t,
  zhCN,
} from './index';

/** Recursively collect every leaf dot-path key of a catalog. */
function leafKeys(node: unknown, prefix = ''): string[] {
  if (node && typeof node === 'object') {
    return Object.entries(node as Record<string, unknown>).flatMap(([k, v]) =>
      leafKeys(v, prefix ? `${prefix}.${k}` : k),
    );
  }
  return [prefix];
}

describe('i18n catalogs', () => {
  it('zh-CN mirrors every en key (no missing translations)', () => {
    const enKeys = leafKeys(en).sort();
    const zhKeys = leafKeys(zhCN).sort();
    expect(zhKeys).toEqual(enKeys);
  });

  it('every leaf value in both catalogs is a non-empty string', () => {
    for (const catalog of Object.values(catalogs)) {
      for (const key of leafKeys(catalog)) {
        const value = key
          .split('.')
          .reduce<unknown>(
            (n, p) =>
              n && typeof n === 'object'
                ? (n as Record<string, unknown>)[p]
                : undefined,
            catalog,
          );
        expect(typeof value).toBe('string');
        expect((value as string).length).toBeGreaterThan(0);
      }
    }
  });

  it('exposes the notification copy the Notifications module (T8.2) consumes', () => {
    for (const type of ['approved', 'rejected', 'deactivated'] as const) {
      for (const lang of ['en', 'zh-CN'] as const) {
        const copy = catalogs[lang].notification[type];
        expect(copy.subject).toBeTruthy();
        expect(copy.greeting).toBeTruthy();
        expect(copy.body).toBeTruthy();
        expect(copy.reasonLabel).toBeTruthy();
        expect(copy.linkLabel).toBeTruthy();
        expect(copy.signoff).toBeTruthy();
      }
    }
  });
});

describe('language resolution', () => {
  it('recognises only supported languages', () => {
    expect(isSupportedLanguage('en')).toBe(true);
    expect(isSupportedLanguage('zh-CN')).toBe(true);
    expect(isSupportedLanguage('fr')).toBe(false);
    expect(isSupportedLanguage(null)).toBe(false);
  });

  it('falls back to en for missing/unknown preferred_language', () => {
    expect(resolveLanguage(undefined)).toBe('en');
    expect(resolveLanguage(null)).toBe('en');
    expect(resolveLanguage('de')).toBe('en');
    expect(resolveLanguage('zh-CN')).toBe('zh-CN');
  });

  it('getCatalog returns the resolved catalog', () => {
    expect(getCatalog('zh-CN')).toBe(zhCN);
    expect(getCatalog('nope')).toBe(en);
  });
});

describe('t() lookup + fallback', () => {
  it('resolves a dot-path key in the requested language', () => {
    expect(t('en', 'error.unauthorized')).toBe(en.error.unauthorized);
    expect(t('zh-CN', 'notification.approved.subject')).toBe(
      zhCN.notification.approved.subject,
    );
  });

  it('interpolates {token} placeholders', () => {
    expect(t('en', 'validation.minLength', { min: 8 })).toBe(
      'Please enter at least 8 characters.',
    );
    expect(t('zh-CN', 'validation.maxLength', { max: 100 })).toContain('100');
  });

  it('returns the key itself for a completely missing path', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(t('en', 'does.not.exist')).toBe('does.not.exist');
    warn.mockRestore();
  });
});
