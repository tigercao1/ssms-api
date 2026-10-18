import { isSupportedLanguage } from '../i18n';
import { EMAIL_LANGUAGES, type EmailLanguage } from './mailer.types';

/**
 * Email language for a recipient: their instructor `preferred_language` when
 * it is a supported language, otherwise `bilingual` (no instructor row, or an
 * unexpected value).
 */
export function resolveEmailLanguage(
  preferredLanguage: string | null | undefined,
): EmailLanguage {
  return isSupportedLanguage(preferredLanguage)
    ? preferredLanguage
    : 'bilingual';
}

export function isEmailLanguage(value: unknown): value is EmailLanguage {
  return EMAIL_LANGUAGES.includes(value as EmailLanguage);
}

export function withPortalLanguage(
  url: string,
  language: EmailLanguage,
): string {
  if (language === 'bilingual' || !URL.canParse(url)) {
    return url;
  }
  const target = new URL(url);
  target.searchParams.set('lang', language);
  return target.toString();
}
