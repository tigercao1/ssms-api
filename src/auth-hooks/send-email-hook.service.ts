import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InstructorsRepository } from '../instructors/instructors.repository';
import {
  resolveEmailLanguage,
  withPortalLanguage,
} from '../mailer/email-language';
import { MailerService } from '../mailer/mailer.service';
import {
  EmailDeliveryError,
  type EmailLanguage,
  type EmailTemplate,
  type EmailTemplateVars,
} from '../mailer/mailer.types';
import type { SendEmailHookPayload } from './send-email-hook.types';

export const EMAIL_SEND_FAILED =
  'We could not send the email right now. Please try again in a few minutes.';

const UNKNOWN_DETAIL = 'unknown';

type PlannedEmail = {
  [T in EmailTemplate]: {
    template: T;
    to: string;
    vars: EmailTemplateVars[T];
    language?: EmailLanguage;
  };
}[EmailTemplate];

interface Recipient {
  language: EmailLanguage;
  instructorId: string | null;
}

/**
 * Turns a verified Supabase Send Email hook payload into one or two branded
 * emails sent synchronously through {@link MailerService}.
 *
 * Links point at `${SUPABASE_URL}/auth/v1/verify`, so the token is verified by
 * Supabase and the user lands on `redirect_to`. Link emails carry no one-time
 * code (the portal has no code-entry screen); the reauthentication email is
 * code-only. The email language follows the user's instructor row, or is
 * bilingual when there is none.
 */
@Injectable()
export class SendEmailHookService {
  private readonly logger = new Logger(SendEmailHookService.name);
  private readonly supabaseUrl: string;

  constructor(
    private readonly mailer: MailerService,
    private readonly instructors: InstructorsRepository,
    config: ConfigService,
  ) {
    this.supabaseUrl = (config.get<string>('SUPABASE_URL') ?? '').replace(
      /\/+$/,
      '',
    );
  }

  /**
   * Sends every email the payload calls for. Throws 400 for a payload it
   * cannot address and 500 when delivery fails.
   */
  async handle(payload: SendEmailHookPayload): Promise<void> {
    const actionType = payload.email_data.email_action_type;
    const recipient = await this.recipientFor(payload.user.id);
    const emails = this.plan(payload, recipient.language);
    try {
      await Promise.all(
        emails.map((email) =>
          this.mailer.send({
            ...email,
            language: email.language ?? recipient.language,
            mode: 'sync',
            authUserId: payload.user.id,
            instructorId: recipient.instructorId,
            metadata: { email_action_type: actionType },
          }),
        ),
      );
    } catch (err) {
      if (err instanceof EmailDeliveryError) {
        this.logger.error(
          `Send email hook (${actionType}) delivery ${err.outcome}: ${err.message}`,
        );
        throw new InternalServerErrorException(EMAIL_SEND_FAILED);
      }
      throw err;
    }
  }

  /** The emails a payload maps to, with portal links in `language`. */
  plan(
    payload: SendEmailHookPayload,
    language: EmailLanguage = 'bilingual',
  ): PlannedEmail[] {
    const { user, email_data: data } = payload;
    const to = user.email;
    const type = data.email_action_type;
    const link = (tokenHash: string, linkLanguage = language) =>
      this.verifyLink(
        tokenHash,
        type,
        withPortalLanguage(data.redirect_to, linkLanguage),
      );

    let emails: PlannedEmail[];
    switch (type) {
      case 'signup':
        emails = [
          {
            template: 'auth.confirm_signup',
            to,
            vars: { confirmUrl: link(requireHash(data.token_hash)) },
          },
        ];
        break;
      case 'recovery':
        emails = [
          {
            template: 'auth.recovery',
            to,
            vars: { resetUrl: link(requireHash(data.token_hash)) },
          },
        ];
        break;
      case 'magiclink':
      case 'email':
        emails = [
          {
            template: 'auth.magic_link',
            to,
            vars: { signInUrl: link(requireHash(data.token_hash)) },
          },
        ];
        break;
      case 'invite':
        emails = [
          {
            template: 'auth.invite',
            to,
            vars: { acceptUrl: link(requireHash(data.token_hash)) },
          },
        ];
        break;
      case 'email_change':
        emails = this.planEmailChange(payload, language);
        break;
      case 'reauthentication':
        if (data.token === '') {
          throw new BadRequestException('email_data.token is required');
        }
        emails = [
          {
            template: 'auth.reauthentication',
            to,
            vars: { code: data.token },
          },
        ];
        break;
      case 'password_changed_notification':
        emails = [{ template: 'auth.password_changed', to, vars: {} }];
        break;
      case 'email_changed_notification':
        emails = [
          {
            template: 'auth.email_changed',
            to: data.old_email || to,
            vars: { oldEmail: data.old_email || to, newEmail: to },
          },
        ];
        break;
      case 'phone_changed_notification':
        emails = [{ template: 'auth.phone_changed', to, vars: {} }];
        break;
      case 'identity_linked_notification':
        emails = [
          {
            template: 'auth.identity_linked',
            to,
            vars: { provider: data.provider || UNKNOWN_DETAIL },
          },
        ];
        break;
      case 'identity_unlinked_notification':
        emails = [
          {
            template: 'auth.identity_unlinked',
            to,
            vars: { provider: data.provider || UNKNOWN_DETAIL },
          },
        ];
        break;
      case 'mfa_factor_enrolled_notification':
        emails = [
          {
            template: 'auth.mfa_enrolled',
            to,
            vars: { factorType: data.factor_type || UNKNOWN_DETAIL },
          },
        ];
        break;
      case 'mfa_factor_unenrolled_notification':
        emails = [
          {
            template: 'auth.mfa_unenrolled',
            to,
            vars: { factorType: data.factor_type || UNKNOWN_DETAIL },
          },
        ];
        break;
      default:
        this.logger.warn(
          `Unknown email_action_type "${type}"; sending the generic email.`,
        );
        emails = [
          {
            template: 'auth.generic',
            to,
            language: 'bilingual',
            vars: {
              actionUrl: data.token_hash
                ? link(data.token_hash, 'bilingual')
                : null,
            },
          },
        ];
    }

    for (const email of emails) {
      if (email.to === '') {
        throw new BadRequestException(`No recipient address for ${type}`);
      }
    }
    return emails;
  }

  private planEmailChange(
    payload: SendEmailHookPayload,
    language: EmailLanguage,
  ): PlannedEmail[] {
    const { user, email_data: data } = payload;
    const newEmail = user.new_email;
    const link = (tokenHash: string) =>
      this.verifyLink(
        tokenHash,
        'email_change',
        withPortalLanguage(data.redirect_to, language),
      );

    if (data.token_hash_new !== '' && data.token_hash !== '') {
      return [
        {
          template: 'auth.email_change',
          to: user.email,
          vars: { confirmUrl: link(data.token_hash_new), newEmail },
        },
        {
          template: 'auth.email_change',
          to: newEmail,
          vars: { confirmUrl: link(data.token_hash), newEmail },
        },
      ];
    }
    return [
      {
        template: 'auth.email_change',
        to: newEmail || user.email,
        vars: {
          confirmUrl: link(requireHash(data.token_hash || data.token_hash_new)),
          newEmail: newEmail || user.email,
        },
      },
    ];
  }

  /** `${SUPABASE_URL}/auth/v1/verify?token=…&type=…&redirect_to=…`. */
  verifyLink(tokenHash: string, type: string, redirectTo: string): string {
    const params = new URLSearchParams({ token: tokenHash, type });
    if (redirectTo !== '') {
      params.set('redirect_to', redirectTo);
    }
    return `${this.supabaseUrl}/auth/v1/verify?${params.toString()}`;
  }

  private async recipientFor(authUserId: string): Promise<Recipient> {
    try {
      const row = await this.instructors.findByAuthUserId(authUserId);
      return {
        language: resolveEmailLanguage(row?.preferred_language),
        instructorId: row?.id ?? null,
      };
    } catch (err) {
      this.logger.warn(
        `Instructor lookup failed for the send email hook; sending bilingual: ${(err as Error).message}`,
      );
      return { language: 'bilingual', instructorId: null };
    }
  }
}

function requireHash(tokenHash: string): string {
  if (tokenHash === '') {
    throw new BadRequestException('email_data.token_hash is required');
  }
  return tokenHash;
}
