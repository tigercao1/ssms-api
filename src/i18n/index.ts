import { en } from './en/messages';
import { zhCN } from './zh-CN/messages';
import {
  DEFAULT_LANGUAGE,
  type MessageCatalog,
  type SupportedLanguage,
} from './messages.types';

export {
  DEFAULT_LANGUAGE,
  type MessageCatalog,
  type SupportedLanguage,
  type NotificationCopy,
  type NotificationMessages,
} from './messages.types';
export { en } from './en/messages';
export { zhCN } from './zh-CN/messages';

/**
 * All shipped catalogs, keyed by language code. Both are typed as
 * {@link MessageCatalog}, so zh-CN is guaranteed to mirror en's keys.
 */
export const catalogs: Record<SupportedLanguage, MessageCatalog> = {
  en,
  'zh-CN': zhCN,
};

/** Fallback chain per PORTAL_I18N_PLAN.md: `zh-CN → en`; unknown → en. */
const FALLBACK_CHAIN: Record<SupportedLanguage, SupportedLanguage[]> = {
  en: ['en'],
  'zh-CN': ['zh-CN', 'en'],
};

/** Type guard for a v1-supported language code. */
export function isSupportedLanguage(
  value: string | null | undefined,
): value is SupportedLanguage {
  return value === 'en' || value === 'zh-CN';
}

/**
 * Resolve any input (e.g. an instructor's `preferred_language`) to a supported
 * language, defaulting to {@link DEFAULT_LANGUAGE} when missing/unknown.
 */
export function resolveLanguage(
  value: string | null | undefined,
): SupportedLanguage {
  return isSupportedLanguage(value) ? value : DEFAULT_LANGUAGE;
}

/** Return the full catalog for a language (resolved + fallback-aware). */
export function getCatalog(
  language: string | null | undefined,
): MessageCatalog {
  return catalogs[resolveLanguage(language)];
}

type Vars = Record<string, string | number>;

/**
 * Translate a dot-path key (e.g. `'error.unauthorized'`,
 * `'notification.approved.subject'`) for a language, walking the fallback chain
 * (`zh-CN → en`) when a key is absent. `{token}` placeholders are interpolated
 * from `vars`.
 *
 * On a completely missing key: warns in non-production and returns the key
 * itself so the UI degrades gracefully (PORTAL_I18N_PLAN.md missing-key policy).
 */
export function t(
  language: string | null | undefined,
  key: string,
  vars?: Vars,
): string {
  const resolved = resolveLanguage(language);
  for (const lang of FALLBACK_CHAIN[resolved]) {
    const value = lookup(catalogs[lang], key);
    if (typeof value === 'string') {
      return vars ? interpolate(value, vars) : value;
    }
  }
  if (process.env.NODE_ENV !== 'production') {
    console.warn(`[i18n] missing key "${key}" for language "${resolved}"`);
  }
  return key;
}

function lookup(catalog: MessageCatalog, key: string): unknown {
  return key
    .split('.')
    .reduce<unknown>(
      (node, part) =>
        node && typeof node === 'object'
          ? (node as Record<string, unknown>)[part]
          : undefined,
      catalog,
    );
}

function interpolate(template: string, vars: Vars): string {
  return template.replace(/\{(\w+)\}/g, (match, token: string) =>
    token in vars ? String(vars[token]) : match,
  );
}
