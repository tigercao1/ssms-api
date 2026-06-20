/**
 * Shared types for the Notifications module (MailerService + Resend).
 *
 * See ADMIN_ROLE_PLAN.md (Notifications), AUTH_V1_DECISIONS.md (Notifications)
 * and V1_SCOPE.md. Admin actions trigger transactional email to the affected
 * instructor; sending is fire-and-forget and must never roll back the action.
 */

/**
 * Languages a notification can be rendered in. Mirrors the instructor profile's
 * `preferred_language` (default `en`). zh-CN is Simplified Chinese.
 */
export type NotificationLanguage = 'en' | 'zh-CN';

/** The default language used when an instructor has no `preferred_language`. */
export const DEFAULT_NOTIFICATION_LANGUAGE: NotificationLanguage = 'en';

/**
 * The transactional notifications v1 sends, one per admin action.
 * Template keys map 1:1 (see AUTH_V1_DECISIONS.md Notifications).
 */
export type NotificationType = 'approved' | 'rejected' | 'deactivated';

/**
 * Context passed to a template renderer to fill an instructor notification.
 * `reason` is optional and only meaningful for `rejected` (from admin metadata).
 */
export interface InstructorNotificationContext {
  /** Recipient email address (the instructor's verified email). */
  to: string;
  /** Which notification to render + send. */
  type: NotificationType;
  /** Instructor's preferred language; falls back to {@link DEFAULT_NOTIFICATION_LANGUAGE}. */
  language?: NotificationLanguage | null;
  /** Display name used in the greeting (optional). */
  displayName?: string | null;
  /** Optional rejection reason, surfaced only for `rejected`. */
  reason?: string | null;
  /** Link back to the portal (optional, used by `approved`). */
  portalUrl?: string | null;
  /** Instructor id, recorded in the failure audit row for traceability. */
  instructorId?: string | null;
}

/** A fully-rendered email ready to hand to the {@link EmailSender}. */
export interface EmailMessage {
  to: string;
  subject: string;
  /** HTML body. */
  html: string;
  /** Plain-text fallback body. */
  text: string;
}
