import * as path from 'node:path';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InMemoryInvitesRepository } from '../../test/helpers/reminders-fakes';
import type { EmailSender } from '../mailer/email-sender.interface';
import { MailerConfig } from '../mailer/mailer.config';
import { MailerService } from '../mailer/mailer.service';
import type { EmailMessage } from '../mailer/mailer.types';
import { EmailRenderer } from '../mailer/templates/email-renderer';
import { InviteDispatcher } from './invite-dispatcher';
import { InviteRemindersService } from './invite-reminders.service';
import {
  runRosterCli,
  type DeliveryReport,
  type RosterDeps,
} from './roster/roster-import';

const NOW = new Date('2026-10-17T15:30:00Z');
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (days: number) =>
  new Date(NOW.getTime() - days * DAY).toISOString();
const inDays = (days: number) =>
  new Date(NOW.getTime() + days * DAY).toISOString();

class RecordingSender implements EmailSender {
  readonly messages: EmailMessage[] = [];
  failFor = new Set<string>();

  send(message: EmailMessage): Promise<{ id?: string }> {
    if (this.failFor.has(message.to)) {
      return Promise.reject(new Error('resend down'));
    }
    this.messages.push(message);
    return Promise.resolve({ id: `resend-${this.messages.length}` });
  }

  isConfigured(): boolean {
    return true;
  }
}

function build(env: Record<string, string> = {}) {
  const config = new ConfigService({ NODE_ENV: 'production', ...env });
  const mailerConfig = new MailerConfig(config);
  const sender = new RecordingSender();
  const supabase = {
    from: () => ({ insert: () => Promise.resolve({ error: null }) }),
  };
  const mailer = new MailerService(
    sender,
    new EmailRenderer(mailerConfig),
    mailerConfig,
    supabase as never,
  );
  const invites = new InMemoryInvitesRepository();
  const dispatcher = new InviteDispatcher(invites, mailer);
  const service = new InviteRemindersService(
    invites,
    dispatcher,
    mailer,
    config,
  );
  service.sleep = () => Promise.resolve();
  const due = () =>
    invites.seed({ sent_at: daysAgo(8), expires_at: inDays(22) });
  return { invites, sender, service, dispatcher, due };
}

describe('InviteRemindersService', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: NOW, doNotFake: ['setTimeout', 'setImmediate'] });
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('reminds a due invite once and never again', async () => {
    const { invites, sender, service, due } = build();
    const invite = due();

    const first = await service.remind('2026/27');
    expect(first).toMatchObject({ candidates: 1, sent: 1, failed: [] });
    expect(sender.messages.map((m) => m.to)).toEqual([invite.email]);
    expect(invites.rows.get(invite.id)?.reminded_at).toBe(NOW.toISOString());

    jest.setSystemTime(NOW.getTime() + 3 * DAY);
    const later = await service.remind('2026/27');
    expect(later).toMatchObject({ candidates: 0, sent: 0 });
    expect(sender.messages).toHaveLength(1);
  });

  it('skips expired, redeemed, activated, recently sent, unsent and other-season invites', async () => {
    const { invites, sender, service, due } = build();
    const remindable = due();
    invites.seed({ sent_at: daysAgo(8), expires_at: daysAgo(1) });
    invites.seed({
      sent_at: daysAgo(8),
      expires_at: inDays(22),
      redeemed_at: daysAgo(2),
    });
    invites.seed({
      sent_at: daysAgo(8),
      expires_at: inDays(22),
      activated_at: daysAgo(2),
    });
    invites.seed({ sent_at: daysAgo(6), expires_at: inDays(24) });
    invites.seed({ sent_at: null, expires_at: inDays(22) });
    invites.seed({
      sent_at: daysAgo(8),
      expires_at: inDays(22),
      reminded_at: daysAgo(1),
    });
    invites.seed({
      sent_at: daysAgo(8),
      expires_at: inDays(22),
      season: '2025/26',
    });

    const result = await service.remind('2026/27');

    expect(result).toMatchObject({ candidates: 1, sent: 1 });
    expect(sender.messages.map((m) => m.to)).toEqual([remindable.email]);
  });

  it('links the reminder to PORTAL_URL, defaulting to the production portal', async () => {
    const configured = build({ PORTAL_URL: 'https://portal.example.com/' });
    configured.due();
    await configured.service.remind('2026/27');
    expect(configured.sender.messages[0].html).toContain(
      'https://portal.example.com/activate?t=',
    );

    const byDefault = build();
    byDefault.due();
    await byDefault.service.remind('2026/27');
    expect(byDefault.sender.messages[0].html).toContain(
      'https://app.ssnow.club/activate?t=',
    );
    expect(byDefault.sender.messages[0].html).not.toContain('localhost');
  });

  it('refuses to send in production when PORTAL_URL is a local address', async () => {
    const { sender, service, due } = build({
      PORTAL_URL: 'http://localhost:5173',
    });
    due();
    await expect(service.remind('2026/27')).rejects.toThrow(/local address/);
    expect(sender.messages).toEqual([]);
  });

  it('allows a local portal outside production', async () => {
    const { sender, service, due } = build({
      NODE_ENV: 'development',
      PORTAL_URL: 'http://localhost:5173',
    });
    due();
    await service.remind('2026/27');
    expect(sender.messages[0].html).toContain('http://localhost:5173/activate');
  });

  it('releases the claim of a failed send so the next run retries it', async () => {
    const { invites, sender, service, due } = build();
    const invite = due();
    sender.failFor.add(invite.email);

    const failed = await service.remind('2026/27');
    expect(failed.failed).toEqual([
      expect.objectContaining({ inviteId: invite.id, email: invite.email }),
    ]);
    expect(invites.rows.get(invite.id)).toMatchObject({
      reminded_at: null,
      remind_claimed_at: null,
    });

    sender.failFor.clear();
    jest.setSystemTime(NOW.getTime() + DAY);
    await expect(service.remind('2026/27')).resolves.toMatchObject({
      sent: 1,
    });
  });

  it('shares its selection and claims with import-season-roster --remind', async () => {
    const { invites, sender, service, dispatcher, due } = build();
    due();
    due();
    await service.remind('2026/27');
    expect(sender.messages).toHaveLength(2);

    const deps: RosterDeps = {
      reader: () => {
        throw new Error('unused');
      },
      writer: () => {
        throw new Error('unused');
      },
      invites: () => invites,
      dispatcher: () => dispatcher,
      readFile: () => Promise.resolve(''),
      writeFile: () => Promise.resolve(),
      sleep: () => Promise.resolve(),
      log: () => undefined,
      now: () => new Date(),
      repoRoot: path.resolve(__dirname, '../..'),
      env: { SSMS_ENV: 'dev' },
    };
    const report = (await runRosterCli(deps, [
      '--remind',
      '--season',
      '2026/27',
    ])) as DeliveryReport;
    expect(report.counts).toMatchObject({ candidates: 0, sent: 0 });

    const fresh = due();
    const cli = (await runRosterCli(deps, ['--remind'])) as DeliveryReport;
    expect(cli.counts).toMatchObject({ candidates: 1, sent: 1 });
    await expect(service.remind('2026/27')).resolves.toMatchObject({
      candidates: 0,
    });
    expect(sender.messages.map((m) => m.to)).toContain(fresh.email);
    expect(sender.messages).toHaveLength(3);
  });

  it('paces sends like the script', async () => {
    const { service, due } = build();
    const sleep = jest.fn().mockResolvedValue(undefined);
    service.sleep = sleep;
    due();
    due();
    await service.remind('2026/27');
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(500);
  });
});
