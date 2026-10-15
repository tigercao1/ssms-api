import type { SupportedLanguage } from '../i18n';

/**
 * Language an email is rendered in. `bilingual` renders the en block, a
 * divider, then the zh-CN block, with a `"<en> / <zh>"` subject. It is used when
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
  | 'auth.email_changed'
  | 'auth.phone_changed'
  | 'auth.identity_linked'
  | 'auth.identity_unlinked'
  | 'auth.mfa_enrolled'
  | 'auth.mfa_unenrolled'
  | 'auth.generic'
  | 'invite.season'
  | 'invite.reminder'
  | 'certification.expiring'
  | 'certification.expired'
  | 'admin.instructor_pending'
  | 'documents.assigned'
  | 'documents.reminder'
  | 'documents.completed';

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

/** A document title in both languages; zh-CN emails fall back to `titleEn`. */
export interface EmailDocumentTitle {
  titleEn: string;
  titleZh?: string | null;
}

interface DocumentListVars extends GreetingVars {
  documents: EmailDocumentTitle[];
  onboardingUrl: string;
}

interface CertificationExpiryVars extends GreetingVars {
  org: 'csia' | 'casi';
  track: 'regular' | 'park' | 'carving';
  level: number;
  /** Last valid day, YYYY-MM-DD. */
  validUntil: string;
  uploadUrl: string;
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
  'auth.email_changed': { oldEmail: string; newEmail: string };
  'auth.phone_changed': Record<string, never>;
  'auth.identity_linked': { provider: string };
  'auth.identity_unlinked': { provider: string };
  'auth.mfa_enrolled': { factorType: string };
  'auth.mfa_unenrolled': { factorType: string };
  'auth.generic': { actionUrl?: string | null };
  'invite.season': InviteVars;
  'invite.reminder': InviteVars;
  'certification.expiring': CertificationExpiryVars;
  'certification.expired': CertificationExpiryVars;
  'admin.instructor_pending': { instructorEmail: string; reviewUrl: string };
  'documents.assigned': DocumentListVars & {
    /** Sent on admin approval: opens with the approval instead of the plain intro. */
    approved?: boolean;
  };
  'documents.reminder': DocumentListVars;
  'documents.completed': GreetingVars & {
    document: EmailDocumentTitle;
    /** SHA-256 (hex) of the attached signed PDF. */
    sha256: string;
    /** Portal link for instructors; omitted for recipients without a login. */
    onboardingUrl?: string | null;
  };
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
  /** Provider idempotency key: repeats of the same key within 24 h send once. */
  idempotencyKey?: string;
  /** Files attached to the email; at most {@link MAX_ATTACHMENT_BYTES} in total. */
  attachments?: EmailAttachment[];
}

/** A file attached to an email. */
export interface EmailAttachment {
  filename: string;
  content: Buffer;
  contentType: string;
}

/**
 * Total attachment size allowed per email, before base64. Resend caps an email
 * at 40 MB after base64 encoding, which inflates content by a third.
 */
export const MAX_ATTACHMENT_BYTES = 30 * 1024 * 1024;

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
  /** Sent as the provider's `Idempotency-Key` header when set. */
  idempotencyKey?: string;
  /** Abort the provider request after this many milliseconds. */
  timeoutMs?: number;
  attachments?: EmailAttachment[];
}

/** A rendered email before it is addressed. */
export type RenderedEmail = Omit<
  EmailMessage,
  'to' | 'idempotencyKey' | 'attachments'
>;
