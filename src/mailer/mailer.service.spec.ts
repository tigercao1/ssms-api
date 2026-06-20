import { MailerService } from './mailer.service';
import { I18nNotificationRenderer } from './templates/i18n-notification-renderer';
import type { EmailSender } from './email-sender.interface';
import type { NotificationRenderer } from './notification-renderer.interface';
import type {
  EmailMessage,
  InstructorNotificationContext,
} from './mailer.types';

/** Captures inserts into audit_log; everything else is a no-op chain. */
function makeSupabase() {
  const inserts: Array<Record<string, unknown>> = [];
  const from = jest.fn(() => ({
    insert: (row: Record<string, unknown>) => {
      inserts.push(row);
      return Promise.resolve({ error: null });
    },
  }));
  return { client: { from } as never, inserts };
}

function ctx(
  over: Partial<InstructorNotificationContext> = {},
): InstructorNotificationContext {
  return {
    to: 'jane@example.com',
    type: 'approved',
    language: 'en',
    displayName: 'Jane',
    instructorId: 'instr-1',
    ...over,
  };
}

const renderer = new I18nNotificationRenderer();

describe('MailerService', () => {
  it('skips (no send, no audit) when the sender is not configured', async () => {
    const { client, inserts } = makeSupabase();
    const send = jest.fn();
    const sender: EmailSender = { isConfigured: () => false, send };
    const service = new MailerService(sender, renderer, client);

    expect(await service.sendInstructorNotification(ctx())).toBe('skipped');
    expect(send).not.toHaveBeenCalled();
    expect(inserts).toHaveLength(0);
  });

  it('sends once on success and writes no failure audit', async () => {
    const { client, inserts } = makeSupabase();
    const send = jest.fn().mockResolvedValue({ id: 'msg-1' });
    const sender: EmailSender = { isConfigured: () => true, send };
    const service = new MailerService(sender, renderer, client);

    expect(await service.sendInstructorNotification(ctx())).toBe('sent');
    expect(send).toHaveBeenCalledTimes(1);
    expect(inserts).toHaveLength(0);
  });

  it('retries on transient failure then succeeds', async () => {
    const { client, inserts } = makeSupabase();
    const send = jest
      .fn()
      .mockRejectedValueOnce(new Error('503'))
      .mockResolvedValueOnce({ id: 'msg-2' });
    const sender: EmailSender = { isConfigured: () => true, send };
    const service = new MailerService(sender, renderer, client);

    expect(await service.sendInstructorNotification(ctx())).toBe('sent');
    expect(send).toHaveBeenCalledTimes(2);
    expect(inserts).toHaveLength(0);
  });

  it('after exhausting retries: resolves (never throws) and audits notification.failure', async () => {
    const { client, inserts } = makeSupabase();
    const send = jest.fn().mockRejectedValue(new Error('hard down'));
    const sender: EmailSender = { isConfigured: () => true, send };
    const service = new MailerService(sender, renderer, client);

    // Must not throw — the admin action must survive a dead mailer.
    const outcome = await service.sendInstructorNotification(
      ctx({ type: 'rejected', reason: 'incomplete certs' }),
    );

    expect(outcome).toBe('failed');
    expect(send).toHaveBeenCalledTimes(3);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({
      actor_role: 'system',
      action: 'notification.failure',
      target_type: 'instructor',
      target_id: 'instr-1',
    });
    expect(inserts[0].metadata).toMatchObject({
      notification_type: 'rejected',
      attempts: 3,
      error: 'hard down',
    });
  });

  it('redacts the recipient in the audit metadata (no raw local part)', async () => {
    const { client, inserts } = makeSupabase();
    const sender: EmailSender = {
      isConfigured: () => true,
      send: jest.fn().mockRejectedValue(new Error('x')),
    };
    const service = new MailerService(sender, renderer, client);

    await service.sendInstructorNotification(ctx({ to: 'jane@example.com' }));

    const recipient = (inserts[0].metadata as { recipient: string }).recipient;
    expect(recipient).not.toContain('jane');
    expect(recipient).toContain('@example.com');
  });

  it('audits and does not throw when rendering itself fails', async () => {
    const { client, inserts } = makeSupabase();
    const send = jest.fn();
    const sender: EmailSender = { isConfigured: () => true, send };
    const boom: NotificationRenderer = {
      render: (): EmailMessage => {
        throw new Error('template blew up');
      },
    };
    const service = new MailerService(sender, boom, client);

    expect(await service.sendInstructorNotification(ctx())).toBe('failed');
    expect(send).not.toHaveBeenCalled();
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({ action: 'notification.failure' });
  });

  it('never throws even if the audit write itself fails', async () => {
    const from = jest.fn(() => ({
      insert: () => Promise.resolve({ error: { message: 'audit down' } }),
    }));
    const client = { from } as never;
    const sender: EmailSender = {
      isConfigured: () => true,
      send: jest.fn().mockRejectedValue(new Error('down')),
    };
    const service = new MailerService(sender, renderer, client);

    await expect(service.sendInstructorNotification(ctx())).resolves.toBe(
      'failed',
    );
  });
});
