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

  it('brands every email subject and sign-off as Serendipity Snow Club', () => {
    for (const lang of ['en', 'zh-CN'] as const) {
      const { layout } = catalogs[lang].email;
      expect(layout.signoffTeam).toContain('Serendipity Snow Club');
      expect(layout.footerQuestions).toContain('info@ssnow.club');
    }
    expect(zhCN.email.layout.signoffTeam).toBe('Serendipity Snow Club 团队');
  });

  it('keeps every email paragraph list the same length in both languages', () => {
    const walk = (enNode: unknown, zhNode: unknown): void => {
      if (Array.isArray(enNode)) {
        expect((zhNode as unknown[]).length).toBe(enNode.length);
        return;
      }
      if (enNode && typeof enNode === 'object') {
        for (const [key, value] of Object.entries(enNode)) {
          walk(value, (zhNode as Record<string, unknown>)[key]);
        }
      }
    };
    walk(en.email, zhCN.email);
  });

  it('drops the old "visible to partners" wording from instructor emails', () => {
    const all = JSON.stringify([en.email, zhCN.email]);
    expect(all).not.toMatch(/partner/i);
    expect(all).not.toContain('合作伙伴');
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
    expect(t('zh-CN', 'email.approved.subject')).toBe(
      zhCN.email.approved.subject,
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
