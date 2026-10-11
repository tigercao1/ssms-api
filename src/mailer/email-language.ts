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
