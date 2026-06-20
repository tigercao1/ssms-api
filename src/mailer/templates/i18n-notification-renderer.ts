import { Injectable } from '@nestjs/common';
import { getCatalog, resolveLanguage } from '../../i18n';
import type { NotificationCopy } from '../../i18n';
import type { NotificationRenderer } from '../notification-renderer.interface';
import type {
  EmailMessage,
  InstructorNotificationContext,
} from '../mailer.types';

/**
 * Template-backed {@link NotificationRenderer} (T8.2).
 *
 * Renders the three admin-action emails — `approved` / `rejected` /
 * `deactivated` — in **en + zh-CN**, picking the language from the instructor's
 * `preferred_language` (falling back to English when missing/unknown, per
 * PORTAL_I18N_PLAN.md).
 *
 * Copy is NOT duplicated here: it is pulled from the shared i18n catalog
 * (`src/i18n`, `notification.*`), so wording + translation review live in one
 * place (T9.1 en / T9.2 zh-CN). This file owns the *template* — the structural
 * layout (greeting, body, optional reason/link, signoff) and HTML escaping.
 */
@Injectable()
export class I18nNotificationRenderer implements NotificationRenderer {
  render(context: InstructorNotificationContext): EmailMessage {
    const language = resolveLanguage(context.language);
    const copy: NotificationCopy =
      getCatalog(language).notification[context.type];

    const greetingName = context.displayName?.trim();
    const greeting = greetingName
      ? `${copy.greeting} ${greetingName},`
      : `${copy.greeting},`;

    const lines: string[] = [greeting, '', copy.body];

    // `rejected`: surface the optional admin reason when present.
    if (context.type === 'rejected' && context.reason?.trim()) {
      lines.push('', `${copy.reasonLabel}: ${context.reason.trim()}`);
    }
    // `approved`: include the portal link when present.
    if (context.type === 'approved' && context.portalUrl?.trim()) {
      lines.push('', `${copy.linkLabel}: ${context.portalUrl.trim()}`);
    }
    lines.push('', copy.signoff);

    const text = lines.join('\n');
    const html = lines
      .map((line) => (line === '' ? '<br/>' : `<p>${escapeHtml(line)}</p>`))
      .join('');

    return { to: context.to, subject: copy.subject, html, text };
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
