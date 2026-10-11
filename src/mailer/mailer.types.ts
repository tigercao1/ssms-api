import type { SupportedLanguage } from '../i18n';

/**
 * Language an email is rendered in. `bilingual` renders the zh-CN block, a
 * divider, then the en block, with a `"<zh> / <en>"` subject. It is used when
 * the recipient has no instructor row (and so no `preferred_language`).
 */
export type EmailLanguage = SupportedLanguage | 'bilingual';

export const EMAIL_LANGUAGES: readonly EmailLanguage[] = [
  'en',
  'zh-CN',
  'bilingual',
];

/** Every transactional email the API can send. */
export type EmailTemplate =
  | 'approved'
  | 'rejected'
  | 'deactivated'
  | 'reactivated'
  | 'auth.confirm_signup'
  | 'auth.recovery'
  | 'auth.magic_link'
  | 'auth.invite'
  | 'auth.email_change'
  | 'auth.reauthentication'
  | 'auth.password_changed'
  | 'invite.season'
  | 'invite.reminder'
  | 'admin.instructor_pending';

interface GreetingVars {
  /** Recipient's display name for the greeting; omitted or blank → "Hi there". */
  displayName?: string | null;
}

interface InviteVars extends GreetingVars {
  /** Season label shown in copy, e.g. `2026/27`. */
  season: string;
  activateUrl: string;
  validDays: number;
}

/** Variables each template needs, keyed by template. */
export interface EmailTemplateVars {
  approved: GreetingVars & { loginUrl: string };
  rejected: GreetingVars & { reason?: string | null };
  deactivated: GreetingVars;
  reactivated: GreetingVars & { loginUrl: string };
  'auth.confirm_signup': { confirmUrl: string; code?: string | null };
  'auth.recovery': { resetUrl: string; code?: string | null };
  'auth.magic_link': { signInUrl: string; code?: string | null };
  'auth.invite': { acceptUrl: string };
  'auth.email_change': {
    confirmUrl: string;
    newEmail: string;
    code?: string | null;
  };
  'auth.reauthentication': { code: string };
  'auth.password_changed': Record<string, never>;
  'invite.season': InviteVars;
  'invite.reminder': InviteVars;
  'admin.instructor_pending': { instructorEmail: string; reviewUrl: string };
}

/**
 * `background`: retries, never throws, resolves to the outcome (callers `void`
 * it). `sync`: retries, then throws {@link EmailDeliveryError} when the email
 * was not sent — for callers where a user is waiting on the email.
 */
export type SendMode = 'background' | 'sync';

export interface SendEmailRequest<T extends EmailTemplate = EmailTemplate> {
  template: T;
  to: string;
  language: EmailLanguage;
  vars: EmailTemplateVars[T];
  mode: SendMode;
  instructorId?: string | null;
  authUserId?: string | null;
  /** Extra non-secret context stored on the `email_log` row. */
  metadata?: Record<string, unknown>;
}

/** Result of a send (for callers / tests / observability). */
export type SendOutcome = 'sent' | 'skipped' | 'failed';

/** Thrown by `MailerService.send` in `sync` mode when the email was not sent. */
export class EmailDeliveryError extends Error {
  constructor(
    readonly outcome: Exclude<SendOutcome, 'sent'>,
    message: string,
  ) {
    super(message);
    this.name = 'EmailDeliveryError';
  }
}

/** A fully-rendered email ready to hand to the {@link EmailSender}. */
export interface EmailMessage {
  to: string;
  subject: string;
  /** HTML body. */
  html: string;
  /** Plain-text alternative body. */
  text: string;
}

/** A rendered email before it is addressed. */
export type RenderedEmail = Omit<EmailMessage, 'to'>;
