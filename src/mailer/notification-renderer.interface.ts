import type {
  EmailMessage,
  InstructorNotificationContext,
} from './mailer.types';

/**
 * Turns an {@link InstructorNotificationContext} into a sendable
 * {@link EmailMessage}, picking copy by `type` and `language`.
 *
 * v1 binds {@link NOTIFICATION_RENDERER} to the template-backed
 * `I18nNotificationRenderer` (`templates/`), which renders en + zh-CN copy from
 * the shared i18n catalog by `preferred_language`. Swap the binding to change
 * how notifications are rendered — MailerService does not change.
 */
export interface NotificationRenderer {
  render(context: InstructorNotificationContext): EmailMessage;
}

/** DI token for the active {@link NotificationRenderer}. */
export const NOTIFICATION_RENDERER = Symbol('NOTIFICATION_RENDERER');
