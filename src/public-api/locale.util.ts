/**
 * Locale selection for bilingual instructor fields (T7.9).
 *
 * Strategy (LOCALIZATION_STRATEGY.md + PUBLIC_API_PLAN.md § Locale parameter):
 * locale-aware fields (`display_name`, `bio`) are returned in the requested
 * locale, falling back to English when the localized value is missing/blank.
 *
 * Reference-data labels are NOT translated server-side — consumers localize via
 * the stable `key`; we only ship the English `name` as a ready-to-render
 * convenience `label` (see LOCALIZATION_STRATEGY.md § Option 2 Hybrid).
 */

export type PublicLocale = 'en' | 'zh-CN';

/**
 * Pick the value for `locale`, falling back to English.
 *
 *   pickLocalized('zh-CN', 'Jane', '简')   -> '简'
 *   pickLocalized('zh-CN', 'Jane', null)   -> 'Jane'   (fallback)
 *   pickLocalized('zh-CN', 'Jane', '')     -> 'Jane'   (blank counts as missing)
 *   pickLocalized('en',    'Jane', '简')   -> 'Jane'
 */
export function pickLocalized(
  locale: PublicLocale,
  en: string | null | undefined,
  zh: string | null | undefined,
): string {
  if (locale === 'zh-CN' && zh != null && zh.trim() !== '') {
    return zh;
  }
  return en ?? '';
}

/**
 * Like {@link pickLocalized} but preserves `null` for optional fields (e.g.
 * `bio`) where an absent English value should surface as `null`, not `''`.
 */
export function pickLocalizedNullable(
  locale: PublicLocale,
  en: string | null | undefined,
  zh: string | null | undefined,
): string | null {
  if (locale === 'zh-CN' && zh != null && zh.trim() !== '') {
    return zh;
  }
  return en ?? null;
}
