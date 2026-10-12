import { ConfigService } from '@nestjs/config';
import { MailerConfig } from './mailer.config';
import { MailerService } from './mailer.service';
import { EmailRenderer } from './templates/email-renderer';
import type { EmailSender } from './email-sender.interface';
import { EmailDeliveryError, type SendEmailRequest } from './mailer.types';

type Row = Record<string, unknown>;

/** Captures inserts per table; everything else is a no-op chain. */
function makeSupabase(insertError: { message: string } | null = null) {
  const inserts: Record<string, Row[]> = { audit_log: [], email_log: [] };
  const from = jest.fn((table: string) => ({
    insert: (row: Row) => {
      (inserts[table] ??= []).push(row);
      return Promise.resolve({ error: insertError });
    },
  }));
  return { client: { from } as never, inserts };
}

const config = new MailerConfig({
  get: (key: string) => ({ PORTAL_URL: 'https://portal.example.com/' })[key],
} as unknown as ConfigService);
const renderer = new EmailRenderer(config);

function request(
  over: Partial<SendEmailRequest<'approved'>> = {},
): SendEmailRequest<'approved'> {
  return {
    template: 'approved',
    to: 'jane@example.com',
    language: 'en',
    vars: { displayName: 'Jane', loginUrl: 'https://portal.example.com/login' },
    mode: 'background',
    instructorId: 'instr-1',
    authUserId: 'auth-1',
    ...over,
  };
}

function service(
  sender: EmailSender,
  client: never,
  emailRenderer: EmailRenderer = renderer,
): MailerService {
  return new MailerService(sender, emailRenderer, config, client);
}

describe('MailerService', () => {
  it('builds portal links from PORTAL_URL without a double slash', () => {
    const { client } = makeSupabase();
    const mailer = service(
      { isConfigured: () => true, send: jest.fn() },
      client,
    );
    expect(mailer.portalLink('/login')).toBe(
      'https://portal.example.com/login',
    );
    expect(mailer.portalLink('admin/instructors/1')).toBe(
      'https://portal.example.com/admin/instructors/1',
    );
  });

  it('skips when the sender is not configured and logs a skipped email_log row', async () => {
    const { client, inserts } = makeSupabase();
    const send = jest.fn();
    const mailer = service({ isConfigured: () => false, send }, client);

    expect(await mailer.send(request())).toBe('skipped');
    expect(send).not.toHaveBeenCalled();
    expect(inserts.audit_log).toHaveLength(0);
    expect(inserts.email_log).toEqual([
      expect.objectContaining({
        template: 'approved',
        recipient: 'jane@example.com',
        language: 'en',
        status: 'skipped',
        instructor_id: 'instr-1',
        auth_user_id: 'auth-1',
      }),
    ]);
  });

  it('sends the rendered email and logs a sent row with the provider id', async () => {
    const { client, inserts } = makeSupabase();
    const send = jest.fn().mockResolvedValue({ id: 'msg-1' });
    const mailer = service({ isConfigured: () => true, send }, client);

    expect(await mailer.send(request({ metadata: { source: 'test' } }))).toBe(
      'sent',
    );
    expect(send).toHaveBeenCalledTimes(1);
    const [message] = send.mock.calls[0] as [{ to: string; html: string }];
    expect(message.to).toBe('jane@example.com');
    expect(message.html).toContain('https://portal.example.com/login');
    expect(inserts.audit_log).toHaveLength(0);
    expect(inserts.email_log).toHaveLength(1);
    expect(inserts.email_log[0]).toMatchObject({
      status: 'sent',
      provider_id: 'msg-1',
      error: null,
      metadata: {
        source: 'test',
        mode: 'background',
        attempts: 1,
        subject: expect.any(String) as string,
      },
    });
  });

  it('retries on transient failure then succeeds', async () => {
    const { client, inserts } = makeSupabase();
    const send = jest
      .fn()
      .mockRejectedValueOnce(new Error('503'))
      .mockResolvedValueOnce({ id: 'msg-2' });
    const mailer = service({ isConfigured: () => true, send }, client);

    expect(await mailer.send(request())).toBe('sent');
    expect(send).toHaveBeenCalledTimes(2);
    expect(inserts.audit_log).toHaveLength(0);
    expect(inserts.email_log[0]).toMatchObject({
      status: 'sent',
      metadata: { attempts: 2 },
    });
  });

  it('sends the same idempotency key on every attempt, and none when unset', async () => {
    const { client } = makeSupabase();
    const send = jest
      .fn()
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValue({ id: 'msg-3' });
    const mailer = service({ isConfigured: () => true, send }, client);

    await mailer.send(request({ idempotencyKey: 'invite-1-sent-x' }));
    await mailer.send(request());

    const messages = (send.mock.calls as [Record<string, unknown>][]).map(
      ([m]) => m,
    );
    expect(messages.map((m) => m.idempotencyKey)).toEqual([
      'invite-1-sent-x',
      'invite-1-sent-x',
      undefined,
    ]);
    expect(messages[2]).not.toHaveProperty('idempotencyKey');
  });

  it('background: after exhausting retries resolves failed, audits and logs', async () => {
    const { client, inserts } = makeSupabase();
    const send = jest.fn().mockRejectedValue(new Error('hard down'));
    const mailer = service({ isConfigured: () => true, send }, client);

    const outcome = await mailer.send({
      template: 'rejected',
      to: 'jane@example.com',
      language: 'zh-CN',
      vars: { reason: 'incomplete certs' },
      mode: 'background',
      instructorId: 'instr-1',
    });

    expect(outcome).toBe('failed');
    expect(send).toHaveBeenCalledTimes(3);
    expect(inserts.audit_log).toHaveLength(1);
    expect(inserts.audit_log[0]).toMatchObject({
      actor_role: 'system',
      action: 'notification.failure',
      target_type: 'instructor',
      target_id: 'instr-1',
      metadata: {
        notification_type: 'rejected',
        language: 'zh-CN',
        attempts: 3,
        error: 'hard down',
      },
    });
    expect(inserts.email_log[0]).toMatchObject({
      template: 'rejected',
      status: 'failed',
      error: 'hard down',
      metadata: { attempts: 3, mode: 'background' },
    });
  });

  it('sync: throws EmailDeliveryError after exhausting retries', async () => {
    const { client, inserts } = makeSupabase();
    const send = jest.fn().mockRejectedValue(new Error('hard down'));
    const mailer = service({ isConfigured: () => true, send }, client);

    const promise = mailer.send(request({ mode: 'sync' }));
    await expect(promise).rejects.toBeInstanceOf(EmailDeliveryError);
    await expect(promise).rejects.toMatchObject({
      outcome: 'failed',
      message: 'hard down',
    });
    expect(send).toHaveBeenCalledTimes(2);
    expect(inserts.email_log[0]).toMatchObject({
      status: 'failed',
      metadata: { mode: 'sync', attempts: 2 },
    });
  });

  it('sync: bounds each attempt to fit the 5s hook budget', async () => {
    const { client } = makeSupabase();
    const send = jest.fn().mockRejectedValue(new Error('timeout'));
    const mailer = service({ isConfigured: () => true, send }, client);

    await expect(mailer.send(request({ mode: 'sync' }))).rejects.toBeInstanceOf(
      EmailDeliveryError,
    );
    const timeouts = send.mock.calls.map(
      ([message]: [{ timeoutMs?: number }]) => message.timeoutMs ?? Infinity,
    );
    const worstCaseMs = timeouts.reduce((sum, ms) => sum + ms, 0) + 250;
    expect(worstCaseMs).toBeLessThan(5_000);
  });

  it('background: gives each attempt a longer timeout', async () => {
    const { client } = makeSupabase();
    const send = jest.fn().mockResolvedValue({ id: 'x' });
    const mailer = service({ isConfigured: () => true, send }, client);

    await mailer.send(request({ mode: 'background' }));
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 10_000 }),
    );
  });

  it('sync: throws when the sender is not configured', async () => {
    const { client, inserts } = makeSupabase();
    const mailer = service(
      { isConfigured: () => false, send: jest.fn() },
      client,
    );

    await expect(mailer.send(request({ mode: 'sync' }))).rejects.toMatchObject({
      outcome: 'skipped',
    });
    expect(inserts.email_log[0]).toMatchObject({ status: 'skipped' });
  });

  it('sync: resolves sent on success', async () => {
    const { client } = makeSupabase();
    const mailer = service(
      { isConfigured: () => true, send: jest.fn().mockResolvedValue({}) },
      client,
    );
    await expect(mailer.send(request({ mode: 'sync' }))).resolves.toBe('sent');
  });

  it('redacts the recipient in the audit metadata (no raw local part)', async () => {
    const { client, inserts } = makeSupabase();
    const mailer = service(
      {
        isConfigured: () => true,
        send: jest.fn().mockRejectedValue(new Error('x')),
      },
      client,
    );

    await mailer.send(request({ to: 'jane@example.com' }));

    const recipient = (inserts.audit_log[0].metadata as { recipient: string })
      .recipient;
    expect(recipient).not.toContain('jane');
    expect(recipient).toContain('@example.com');
  });

  it('audits, logs and does not throw when rendering itself fails', async () => {
    const { client, inserts } = makeSupabase();
    const send = jest.fn();
    const boom = {
      render: () => {
        throw new Error('template blew up');
      },
    } as unknown as EmailRenderer;
    const mailer = service({ isConfigured: () => true, send }, client, boom);

    expect(await mailer.send(request())).toBe('failed');
    expect(send).not.toHaveBeenCalled();
    expect(inserts.audit_log).toEqual([
      expect.objectContaining({ action: 'notification.failure' }),
    ]);
    expect(inserts.email_log[0]).toMatchObject({
      status: 'failed',
      error: 'template blew up',
      metadata: { attempts: 0 },
    });
  });

  it('never throws in background mode even if the log and audit writes fail', async () => {
    const { client } = makeSupabase({ message: 'db down' });
    const mailer = service(
      {
        isConfigured: () => true,
        send: jest.fn().mockRejectedValue(new Error('down')),
      },
      client,
    );

    await expect(mailer.send(request())).resolves.toBe('failed');
  });

  it('never throws in background mode when the database client itself throws', async () => {
    const client = {
      from: () => {
        throw new Error('client exploded');
      },
    } as never;
    const mailer = service(
      { isConfigured: () => true, send: jest.fn().mockResolvedValue({}) },
      client,
    );

    await expect(mailer.send(request())).resolves.toBe('sent');
  });

  it('resolves failed in background mode when the sender check throws', async () => {
    const { client } = makeSupabase();
    const mailer = service(
      {
        isConfigured: () => {
          throw new Error('config exploded');
        },
        send: jest.fn(),
      },
      client,
    );

    await expect(mailer.send(request())).resolves.toBe('failed');
  });
});
