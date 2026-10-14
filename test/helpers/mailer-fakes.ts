import type { MailerService } from '../../src/mailer/mailer.service';
import type {
  EmailTemplate,
  SendEmailRequest,
  SendOutcome,
} from '../../src/mailer/mailer.types';

export const FAKE_PORTAL_URL = 'https://portal.example.com';

/** Records every {@link MailerService.send} request; `outcome` is what sends resolve to. */
export class RecordingMailer {
  readonly sent: SendEmailRequest[] = [];
  outcome: SendOutcome = 'sent';

  send<T extends EmailTemplate>(
    request: SendEmailRequest<T>,
  ): Promise<SendOutcome> {
    this.sent.push(request);
    return Promise.resolve(this.outcome);
  }

  portalLink(path: string): string {
    return `${FAKE_PORTAL_URL}${path}`;
  }

  /** Requests for one template, in send order. */
  sentOf<T extends EmailTemplate>(template: T): SendEmailRequest<T>[] {
    return this.sent.filter(
      (r) => r.template === template,
    ) as unknown as SendEmailRequest<T>[];
  }

  asService(): MailerService {
    return this as unknown as MailerService;
  }
}

/** Lets fire-and-forget work queued on resolved promises finish. */
export function flushBackground(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
