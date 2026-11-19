import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import {
  AMY_ID,
  BEN_ID,
  BLUE_ID,
  CAL_ID,
  InMemoryBookingRemindersRepository,
  InMemoryBookingRepository,
  LEO_ID,
  MEI_ID,
} from '../../test/helpers/booking-fakes';
import { RecordingMailer } from '../../test/helpers/mailer-fakes';
import type { AuditService } from '../audit/audit.service';
import {
  FLY_APP_NAME_KEY,
  PROCESS_GROUP_KEY,
  PRODUCTION_FLY_APP,
} from '../config/process-group';
import type { MailerService } from '../mailer/mailer.service';
import type {
  BookingEmailVars,
  SendEmailRequest,
} from '../mailer/mailer.types';
import { BookingEmailQueue } from './booking-email-queue';
import { BookingReminderSettingsService } from './booking-reminder-settings.service';
import {
  BookingRemindersWorker,
  LESSON_REMINDER_STALE_CLAIM_MS,
  LESSON_REMINDERS_DRAIN_MS,
  LESSON_REMINDERS_FLAG,
  LESSON_REMINDERS_INTERVAL_MS,
  offsetActiveSince,
  reminderDue,
} from './booking-reminders.worker';

const MINUTE = 60_000;
const NOW = Date.parse('2026-12-10T17:00:00.000Z');
const CLASS_A = 'c0000000-0000-4000-8000-0000000000a1';
const CLASS_B = 'c0000000-0000-4000-8000-0000000000b2';
const CLASS_C = 'c0000000-0000-4000-8000-0000000000c3';
const KAI_ID = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';

const at = (ms: number) => new Date(ms).toISOString();

function build() {
  const booking = new InMemoryBookingRepository();
  booking.customers.push({
    id: KAI_ID,
    first_name: 'Kai',
    last_name: 'Lee',
    phone: null,
    email: 'kai@example.com',
  });
  const repo = new InMemoryBookingRemindersRepository(booking);
  const mailer = new RecordingMailer();
  const clock = { value: NOW, now: () => clock.value };
  booking.now = clock.now;
  const env: Record<string, string> = { [LESSON_REMINDERS_FLAG]: 'true' };
  const config = { get: (key: string) => env[key] } as ConfigService;
  const queue = new BookingEmailQueue({
    intervalMs: 0,
    concurrency: Number.POSITIVE_INFINITY,
  });
  const settings = new BookingReminderSettingsService(repo, {
    record: () => Promise.resolve(),
  } as unknown as AuditService);
  const hooks = { beforeSend: (): Promise<void> | void => undefined };
  const service = {
    send: async (request: SendEmailRequest) => {
      await hooks.beforeSend();
      return mailer.send(request);
    },
  } as unknown as MailerService;
  const worker = (q: BookingEmailQueue = queue) =>
    new BookingRemindersWorker(config, repo, service, q, clock);
  const lesson = (
    startsAt: number,
    overrides: Partial<Parameters<InMemoryBookingRepository['add']>[0]> = {},
  ) =>
    booking.add({
      id: CLASS_A,
      starts_at: at(startsAt),
      ends_at: at(startsAt + 60 * MINUTE),
      location_id: BLUE_ID,
      customer_ids: [MEI_ID, KAI_ID],
      starts_at_set_at: at(NOW),
      ...overrides,
    });
  return {
    booking,
    repo,
    mailer,
    hooks,
    clock,
    env,
    queue,
    settings,
    worker,
    lesson,
  };
}

async function tickEveryMinute(
  ctx: ReturnType<typeof build>,
  until: number,
): Promise<[string, number, number][]> {
  const worker = ctx.worker();
  const sends: [string, number, number][] = [];
  for (; ctx.clock.value < until; ctx.clock.value += MINUTE) {
    const before = ctx.mailer.sent.length;
    await worker.tick();
    for (const r of ctx.mailer.sent.slice(before)) {
      const { classIds, offsetMinutes } = r.metadata as {
        classIds: string[];
        offsetMinutes: number;
      };
      const start = Date.parse(
        ctx.booking.classes.find((c) => c.id === classIds[0])!.starts_at,
      );
      sends.push([
        classIds[0],
        offsetMinutes,
        (start - ctx.clock.value) / MINUTE,
      ]);
    }
  }
  return sends;
}

const recipients = (sent: SendEmailRequest[]) =>
  sent.map((r) => `${r.template} ${r.to}`).sort();

describe('reminderDue', () => {
  const DAY = 1440 * MINUTE;
  const longAgo = NOW - 7 * DAY;

  it.each([
    ['exactly at start minus the offset', NOW + 60 * MINUTE, longAgo, 60, true],
    ['a minute before it is due', NOW + 61 * MINUTE, longAgo, 60, false],
    [
      'late, while the lesson is still ahead',
      NOW + 2 * MINUTE,
      longAgo,
      60,
      true,
    ],
    ['a lesson starting right now', NOW, longAgo, 15, false],
    ['a lesson that already started', NOW - MINUTE, longAgo, 15, false],
    ['booked exactly when it fell due', NOW + 60 * MINUTE, NOW, 60, true],
    ['booked after it fell due', NOW + 30 * MINUTE, NOW - MINUTE, 60, false],
    [
      'a day-before reminder for a lesson booked an hour ahead',
      NOW + 60 * MINUTE,
      NOW,
      1440,
      false,
    ],
  ])('%s → %s', (_name, startsAt, setAt, offset, due) => {
    expect(
      reminderDue(
        { starts_at: at(startsAt), starts_at_set_at: at(setAt) },
        offset,
        NOW,
        at(longAgo),
      ),
    ).toBe(due);
  });

  it.each([
    ['fell due before reminders were turned on', NOW - 5 * MINUTE, false],
    ['fell due exactly when reminders were turned on', NOW - 10 * MINUTE, true],
  ])('a reminder that %s', (_name, enabledAt, due) => {
    expect(
      reminderDue(
        { starts_at: at(NOW + 50 * MINUTE), starts_at_set_at: at(longAgo) },
        60,
        NOW,
        at(enabledAt),
      ),
    ).toBe(due);
  });
});

describe('offsetActiveSince', () => {
  const settings = {
    enabled_at: '2026-10-01T00:00:00.000Z',
    offsets_added_at: {
      '1440': '2026-09-01T00:00:00.000Z',
      '60': '2026-11-01T00:00:00.000Z',
    },
  };

  it.each([
    [
      'an offset added before reminders were turned on',
      1440,
      settings.enabled_at,
    ],
    [
      'an offset added after reminders were turned on',
      60,
      '2026-11-01T00:00:00.000Z',
    ],
    ['an offset with no added time', 180, null],
  ])('%s', (_name, offset, since) => {
    expect(offsetActiveSince(settings, offset)).toBe(since);
  });
});

describe('BookingRemindersWorker', () => {
  let ctx: ReturnType<typeof build>;

  beforeEach(() => {
    ctx = build();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('emails each customer and the instructor a day before, in their languages', async () => {
    ctx.lesson(NOW + 1440 * MINUTE);
    await expect(ctx.worker().tick()).resolves.toEqual({
      sent: 3,
      skipped: 0,
      failed: 0,
    });
    expect(recipients(ctx.mailer.sent)).toEqual([
      'booking.reminder.customer kai@example.com',
      'booking.reminder.customer mei@example.com',
      'booking.reminder.instructor amy@example.com',
    ]);
    const [instructor] = ctx.mailer.sentOf('booking.reminder.instructor');
    expect(instructor).toMatchObject({
      language: 'zh-CN',
      mode: 'background',
      instructorId: AMY_ID,
      metadata: {
        booking: 'reminder',
        classIds: [CLASS_A],
        offsetMinutes: 1440,
      },
      idempotencyKey: `booking:reminder:${CLASS_A}:${NOW + 1440 * MINUTE}:1440:instructor:${AMY_ID}`,
    });
    expect(instructor.vars).toMatchObject({
      displayName: 'Amy',
      lessonNameEn: 'Private 1h',
      instructorNameEn: 'Amy',
      location: 'Blue Mountain',
      customerNames: ['Mei Wang', 'Kai Lee'],
      lessons: [
        { startsAt: at(NOW + 1440 * MINUTE), endsAt: at(NOW + 1500 * MINUTE) },
      ],
    });
    expect(instructor.attachments).toBeUndefined();
    expect(ctx.repo.sends.map((s) => s.status)).toEqual([
      'sent',
      'sent',
      'sent',
    ]);
  });

  it("never shows a customer another customer's name or email", async () => {
    ctx.lesson(NOW + 60 * MINUTE);
    await ctx.worker().tick();
    const customers = ctx.mailer.sentOf('booking.reminder.customer');
    expect(customers).toHaveLength(2);
    for (const email of customers) {
      const vars = email.vars;
      expect(email.language).toBe('en');
      expect(vars.customerNames).toEqual([]);
      const other =
        email.to === 'mei@example.com' ? ['Kai', 'kai@'] : ['Mei', 'mei@'];
      for (const leak of other) {
        expect(JSON.stringify(email)).not.toContain(leak);
      }
    }
  });

  it('skips a recipient without an email silently', async () => {
    ctx.lesson(NOW + 60 * MINUTE, { customer_ids: [MEI_ID, LEO_ID] });
    await ctx.worker().tick();
    expect(recipients(ctx.mailer.sent)).toEqual([
      'booking.reminder.customer mei@example.com',
      'booking.reminder.instructor amy@example.com',
    ]);
    expect(ctx.repo.sends.map((s) => s.recipient_id)).not.toContain(LEO_ID);
  });

  it('sends each reminder once across ticks and restarts', async () => {
    ctx.lesson(NOW + 60 * MINUTE);
    await ctx.worker().tick();
    ctx.clock.value += MINUTE;
    await ctx.worker().tick();
    ctx.clock.value += MINUTE;
    await ctx.worker().tick();
    expect(ctx.mailer.sent).toHaveLength(3);
    expect(ctx.repo.sends).toHaveLength(3);
  });

  it('sends each reminder once when two workers tick at the same time', async () => {
    ctx.lesson(NOW + 60 * MINUTE);
    ctx.lesson(NOW + 1440 * MINUTE, {
      id: CLASS_B,
      instructor_id: BEN_ID,
    });
    const runs = await Promise.all([ctx.worker().tick(), ctx.worker().tick()]);
    expect(runs[0].sent + runs[1].sent).toBe(6);
    expect(recipients(ctx.mailer.sent)).toEqual([
      'booking.reminder.customer kai@example.com',
      'booking.reminder.customer kai@example.com',
      'booking.reminder.customer mei@example.com',
      'booking.reminder.customer mei@example.com',
      'booking.reminder.instructor amy@example.com',
      'booking.reminder.instructor ben@example.com',
    ]);
    expect(new Set(ctx.mailer.sent.map((r) => r.idempotencyKey)).size).toBe(6);
  });

  it('sends each configured reminder at its own time', async () => {
    const start = NOW + 1440 * MINUTE;
    ctx.lesson(start);
    const worker = ctx.worker();
    await worker.tick();
    ctx.clock.value = start - 120 * MINUTE;
    await worker.tick();
    ctx.clock.value = start - 60 * MINUTE;
    await worker.tick();
    expect(
      ctx.mailer.sent.map(
        (r) => (r.metadata as { offsetMinutes: number }).offsetMinutes,
      ),
    ).toEqual([1440, 1440, 1440, 60, 60, 60]);
  });

  it('uses the admin reminder times', async () => {
    ctx.repo.setOffsets([2880, 180], ctx.repo.settings.enabled_at);
    ctx.lesson(NOW + 1440 * MINUTE);
    ctx.lesson(NOW + 2880 * MINUTE, { id: CLASS_B, instructor_id: BEN_ID });
    await ctx.worker().tick();
    expect(recipients(ctx.mailer.sent)).toEqual([
      'booking.reminder.customer kai@example.com',
      'booking.reminder.customer mei@example.com',
      'booking.reminder.instructor ben@example.com',
    ]);
  });

  it('sends nothing while reminders are turned off', async () => {
    ctx.repo.settings.enabled = false;
    ctx.lesson(NOW + 60 * MINUTE);
    await ctx.worker().tick();
    expect(ctx.mailer.sent).toEqual([]);
  });

  it.each([
    [
      {
        [LESSON_REMINDERS_FLAG]: 'false',
        [FLY_APP_NAME_KEY]: PRODUCTION_FLY_APP,
      },
      0,
    ],
    [{ [FLY_APP_NAME_KEY]: PRODUCTION_FLY_APP }, 3],
    [{ [FLY_APP_NAME_KEY]: 'ssms-api-dev', NODE_ENV: 'production' }, 0],
    [{ NODE_ENV: 'production' }, 0],
    [{ NODE_ENV: 'development' }, 0],
    [
      { [LESSON_REMINDERS_FLAG]: 'true', [FLY_APP_NAME_KEY]: 'ssms-api-dev' },
      3,
    ],
  ])('follows the %j environment', async (env, count) => {
    delete ctx.env[LESSON_REMINDERS_FLAG];
    Object.assign(ctx.env, env);
    ctx.lesson(NOW + 60 * MINUTE);
    await ctx.worker().tick();
    expect(ctx.mailer.sent).toHaveLength(count);
  });

  it('reminds again for the new time after a reschedule', async () => {
    const start = NOW + 60 * MINUTE;
    ctx.lesson(start);
    await ctx.worker().tick();
    const moved = start + 2 * 1440 * MINUTE;
    await ctx.booking.rebookClass(
      CLASS_A,
      {
        instructor_id: AMY_ID,
        lesson_type_id: null,
        starts_at: at(moved),
        ends_at: at(moved + 60 * MINUTE),
        google_calendar_id: null,
        notes: null,
      },
      null,
    );
    ctx.clock.value = moved - 60 * MINUTE;
    await ctx.worker().tick();
    expect(ctx.mailer.sent).toHaveLength(6);
    expect(
      ctx.mailer.sent
        .slice(3)
        .map((r) => [
          (r.metadata as { offsetMinutes: number }).offsetMinutes,
          (r.vars as BookingEmailVars).lessons[0].startsAt,
        ]),
    ).toEqual(Array<[number, string]>(3).fill([60, at(moved)]));
  });

  it('skips cancelled lessons', async () => {
    ctx.lesson(NOW + 60 * MINUTE, { status: 'cancelled' });
    await ctx.worker().tick();
    expect(ctx.mailer.sent).toEqual([]);
    expect(ctx.repo.sends).toEqual([]);
  });

  it('skips lessons booked with sendEmails false', async () => {
    ctx.lesson(NOW + 60 * MINUTE, { send_emails: false });
    await ctx.worker().tick();
    expect(ctx.mailer.sent).toEqual([]);
  });

  it.each([
    ['imported', 'app_import'],
    ['webhook-created', 'app_webhook'],
  ] as const)('skips %s lessons', async (_name, source) => {
    ctx.lesson(NOW + 60 * MINUTE, { source });
    await ctx.worker().tick();
    expect(ctx.mailer.sent).toEqual([]);
    expect(ctx.repo.sends).toEqual([]);
  });

  it('sends no reminder whose time had passed when the lesson was booked', async () => {
    ctx.lesson(NOW + 30 * MINUTE);
    const worker = ctx.worker();
    for (let i = 0; i < 30; i += 1) {
      await worker.tick();
      ctx.clock.value += MINUTE;
    }
    expect(ctx.mailer.sent).toEqual([]);
    expect(ctx.repo.sends).toEqual([]);
  });

  it('sends a day-before reminder late after the worker was down', async () => {
    const start = NOW + 120 * MINUTE;
    ctx.lesson(start, { starts_at_set_at: at(NOW - 3 * 1440 * MINUTE) });
    await expect(ctx.worker().tick()).resolves.toEqual({
      sent: 3,
      skipped: 0,
      failed: 0,
    });
    expect(
      ctx.mailer.sent.map(
        (r) => (r.metadata as { offsetMinutes: number }).offsetMinutes,
      ),
    ).toEqual([1440, 1440, 1440]);
  });

  it('sends only the reminders still ahead after a reschedule to three hours away', async () => {
    const original = NOW + 5 * 1440 * MINUTE;
    ctx.lesson(original);
    const moved = NOW + 180 * MINUTE;
    await ctx.booking.rebookClass(
      CLASS_A,
      {
        instructor_id: AMY_ID,
        lesson_type_id: null,
        starts_at: at(moved),
        ends_at: at(moved + 60 * MINUTE),
        google_calendar_id: null,
        notes: null,
      },
      null,
    );
    const worker = ctx.worker();
    for (let t = NOW; t < moved; t += MINUTE) {
      ctx.clock.value = t;
      await worker.tick();
    }
    expect(
      ctx.mailer.sent.map(
        (r) => (r.metadata as { offsetMinutes: number }).offsetMinutes,
      ),
    ).toEqual([60, 60, 60]);
  });

  it('after an outage covering both reminder times sends only the 1-hour reminder and supersedes the 1-day one', async () => {
    const start = NOW + 26 * 60 * MINUTE;
    ctx.lesson(start, { starts_at_set_at: at(NOW - 3 * 1440 * MINUTE) });
    const worker = ctx.worker();
    await worker.tick();
    expect(ctx.mailer.sent).toEqual([]);
    ctx.clock.value = start - 30 * MINUTE;
    await expect(worker.tick()).resolves.toEqual({
      sent: 3,
      skipped: 3,
      failed: 0,
    });
    expect(
      ctx.mailer.sent.map(
        (r) => (r.metadata as { offsetMinutes: number }).offsetMinutes,
      ),
    ).toEqual([60, 60, 60]);
    expect(
      ctx.repo.sends
        .filter((s) => s.offset_minutes === 1440)
        .map((s) => [s.status, s.reason]),
    ).toEqual(Array(3).fill(['skipped', 'superseded']));
    ctx.clock.value += MINUTE;
    await expect(worker.tick()).resolves.toEqual({
      sent: 0,
      skipped: 0,
      failed: 0,
    });
    expect(ctx.repo.sends).toHaveLength(6);
  });

  it('sends no backlog for a newly added longer reminder time and sends it on time for later lessons', async () => {
    const admin = { userId: AMY_ID, role: 'admin' } as const;
    const bookedLongAgo = { starts_at_set_at: at(NOW - 14 * 1440 * MINUTE) };
    ctx.lesson(NOW + 2 * 1440 * MINUTE, {
      customer_ids: [MEI_ID],
      ...bookedLongAgo,
    });
    ctx.lesson(NOW + 6 * 1440 * MINUTE, {
      id: CLASS_B,
      instructor_id: BEN_ID,
      customer_ids: [MEI_ID],
      ...bookedLongAgo,
    });
    await ctx.settings.update(
      { enabled: true, offsetsMinutes: [10080, 1440, 60] },
      admin,
    );
    expect(ctx.repo.settings.offsets_added_at).toEqual({
      '10080': at(NOW),
      '1440': '2026-10-01T00:00:00.000Z',
      '60': '2026-10-01T00:00:00.000Z',
    });
    ctx.lesson(NOW + 8 * 1440 * MINUTE, {
      id: CLASS_C,
      instructor_id: CAL_ID,
      customer_ids: [MEI_ID],
      starts_at_set_at: at(NOW + MINUTE),
    });
    expect(await tickEveryMinute(ctx, NOW + 8 * 1440 * MINUTE)).toEqual([
      [CLASS_A, 1440, 1440],
      [CLASS_A, 1440, 1440],
      [CLASS_C, 10080, 10080],
      [CLASS_C, 10080, 10080],
      [CLASS_A, 60, 60],
      [CLASS_A, 60, 60],
      [CLASS_B, 1440, 1440],
      [CLASS_B, 1440, 1440],
      [CLASS_B, 60, 60],
      [CLASS_B, 60, 60],
      [CLASS_C, 1440, 1440],
      [CLASS_C, 1440, 1440],
      [CLASS_C, 60, 60],
      [CLASS_C, 60, 60],
    ]);
  });

  it('treats a removed and re-added or changed reminder time as newly added', async () => {
    const admin = { userId: AMY_ID, role: 'admin' } as const;
    const bookedLongAgo = { starts_at_set_at: at(NOW - 7 * 1440 * MINUTE) };
    ctx.lesson(NOW + 20 * 60 * MINUTE, {
      customer_ids: [MEI_ID],
      ...bookedLongAgo,
    });
    ctx.lesson(NOW + 23 * 60 * MINUTE, {
      id: CLASS_B,
      instructor_id: BEN_ID,
      customer_ids: [MEI_ID],
      ...bookedLongAgo,
    });
    await ctx.settings.update({ enabled: true, offsetsMinutes: [60] }, admin);
    ctx.clock.value += MINUTE;
    await ctx.settings.update(
      { enabled: true, offsetsMinutes: [1440, 1500, 60] },
      admin,
    );
    expect(ctx.repo.settings.offsets_added_at).toEqual({
      '1500': at(NOW + MINUTE),
      '1440': at(NOW + MINUTE),
      '60': '2026-10-01T00:00:00.000Z',
    });
    expect(await tickEveryMinute(ctx, NOW + 23 * 60 * MINUTE)).toEqual([
      [CLASS_A, 60, 60],
      [CLASS_A, 60, 60],
      [CLASS_B, 60, 60],
      [CLASS_B, 60, 60],
    ]);
  });

  it('on first enable sends nothing already overdue and later reminders on schedule', async () => {
    ctx.repo.settings.enabled_at = at(NOW);
    const bookedLongAgo = { starts_at_set_at: at(NOW - 7 * 1440 * MINUTE) };
    const lessons = {
      [CLASS_A]: NOW + 30 * MINUTE,
      [CLASS_B]: NOW + 5 * 60 * MINUTE,
      [CLASS_C]: NOW + 23 * 60 * MINUTE,
    };
    for (const [id, start] of Object.entries(lessons)) {
      ctx.lesson(start, { id, customer_ids: [MEI_ID], ...bookedLongAgo });
    }
    const sends = await tickEveryMinute(ctx, NOW + 24 * 60 * MINUTE);
    expect(sends).toEqual([
      [CLASS_B, 60, 60],
      [CLASS_B, 60, 60],
      [CLASS_C, 60, 60],
      [CLASS_C, 60, 60],
    ]);
  });

  it('sends no backlog when reminders are turned back on after a day off', async () => {
    const admin = { userId: AMY_ID, role: 'admin' } as const;
    const settings = { offsetsMinutes: [1440, 60] };
    const bookedLongAgo = { starts_at_set_at: at(NOW - 7 * 1440 * MINUTE) };
    ctx.lesson(NOW + 20 * 60 * MINUTE, {
      customer_ids: [MEI_ID],
      ...bookedLongAgo,
    });
    ctx.lesson(NOW + 26 * 60 * MINUTE, {
      id: CLASS_B,
      customer_ids: [MEI_ID],
      ...bookedLongAgo,
    });
    ctx.lesson(NOW + 50 * 60 * MINUTE, {
      id: CLASS_C,
      customer_ids: [MEI_ID],
      ...bookedLongAgo,
    });
    await ctx.settings.update({ enabled: false, ...settings }, admin);
    expect(await tickEveryMinute(ctx, NOW + 1440 * MINUTE)).toEqual([]);
    await ctx.settings.update({ enabled: true, ...settings }, admin);
    expect(ctx.repo.settings.enabled_at).toBe(at(NOW + 1440 * MINUTE));
    expect(await tickEveryMinute(ctx, NOW + 51 * 60 * MINUTE)).toEqual([
      [CLASS_B, 60, 60],
      [CLASS_B, 60, 60],
      [CLASS_C, 1440, 1440],
      [CLASS_C, 1440, 1440],
      [CLASS_C, 60, 60],
      [CLASS_C, 60, 60],
    ]);
    await ctx.settings.update({ enabled: true, ...settings }, admin);
    expect(ctx.repo.settings.enabled_at).toBe(at(NOW + 1440 * MINUTE));
  });

  it('does not try to claim reminders it already claimed', async () => {
    ctx.lesson(NOW + 60 * MINUTE);
    const worker = ctx.worker();
    await worker.tick();
    const claim = jest.spyOn(ctx.repo, 'claim');
    ctx.clock.value += MINUTE;
    await worker.tick();
    expect(claim).not.toHaveBeenCalled();
    expect(ctx.mailer.sent).toHaveLength(3);
  });

  it('marks a claim left behind for 15 minutes failed and warns without addresses', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    ctx.lesson(NOW + 1440 * MINUTE);
    await ctx.repo.claim({
      class_id: CLASS_A,
      starts_at: at(NOW + 1440 * MINUTE),
      offset_minutes: 1440,
      audience: 'customer',
      recipient_id: MEI_ID,
    });
    const worker = ctx.worker();
    ctx.clock.value += LESSON_REMINDER_STALE_CLAIM_MS;
    await worker.tick();
    expect(warn).not.toHaveBeenCalled();
    ctx.clock.value += 1;
    await worker.tick();
    const stale = ctx.repo.sends.find((s) => s.recipient_id === MEI_ID);
    expect(stale).toMatchObject({ status: 'failed', reason: 'stale_claim' });
    expect(warn).toHaveBeenCalledTimes(1);
    const [message] = warn.mock.calls[0] as [string];
    expect(message).toContain(stale!.id);
    expect(message).toContain(CLASS_A);
    expect(message).toContain('stale_claim');
    expect(message).not.toMatch(/@|mei/i);
    expect(
      ctx.mailer.sentOf('booking.reminder.customer').map((r) => r.to),
    ).toEqual(['kai@example.com']);
    ctx.clock.value += MINUTE;
    await worker.tick();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('sends a reminder that falls due shortly after booking', async () => {
    ctx.lesson(NOW + 62 * MINUTE);
    const worker = ctx.worker();
    await worker.tick();
    expect(ctx.mailer.sent).toEqual([]);
    ctx.clock.value += 2 * MINUTE;
    await worker.tick();
    expect(ctx.mailer.sent).toHaveLength(3);
  });

  it('records a failed send and does not retry it', async () => {
    ctx.mailer.outcome = 'failed';
    ctx.lesson(NOW + 60 * MINUTE);
    await expect(ctx.worker().tick()).resolves.toEqual({
      sent: 0,
      skipped: 0,
      failed: 3,
    });
    ctx.clock.value += MINUTE;
    await ctx.worker().tick();
    expect(ctx.mailer.sent).toHaveLength(3);
    expect(ctx.repo.sends.map((s) => s.status)).toEqual([
      'failed',
      'failed',
      'failed',
    ]);
  });

  it('claims nothing when the email queue is closed', async () => {
    await ctx.queue.close(0);
    ctx.lesson(NOW + 60 * MINUTE);
    await ctx.worker().tick();
    expect(ctx.mailer.sent).toEqual([]);
    expect(ctx.repo.sends).toEqual([]);
  });

  it('never reminds a lesson cancelled or moved while the tick is sending', async () => {
    const start = NOW + 60 * MINUTE;
    ctx.lesson(start, { customer_ids: [MEI_ID] });
    ctx.lesson(start, {
      id: CLASS_B,
      instructor_id: BEN_ID,
      customer_ids: [KAI_ID],
    });
    ctx.lesson(start, { id: CLASS_C, instructor_id: CAL_ID, customer_ids: [] });
    const moved = start + 3 * 60 * MINUTE;
    ctx.hooks.beforeSend = async () => {
      if (ctx.mailer.sent.length === 0) {
        await ctx.booking.setClassStatus(CLASS_B, 'cancelled');
        await ctx.booking.rebookClass(
          CLASS_C,
          {
            instructor_id: CAL_ID,
            lesson_type_id: null,
            starts_at: at(moved),
            ends_at: at(moved + 60 * MINUTE),
            google_calendar_id: null,
            notes: null,
          },
          null,
        );
      }
    };
    await expect(ctx.worker().tick()).resolves.toEqual({
      sent: 2,
      skipped: 0,
      failed: 0,
    });
    expect(
      ctx.mailer.sent.map(
        (r) => (r.metadata as { classIds: string[] }).classIds,
      ),
    ).toEqual([[CLASS_A], [CLASS_A]]);
    expect(ctx.repo.sends.map((s) => s.class_id)).toEqual([CLASS_A, CLASS_A]);
    ctx.clock.value = moved - 60 * MINUTE;
    await ctx.worker().tick();
    expect(
      ctx.mailer.sent
        .slice(2)
        .map((r) => [r.to, (r.metadata as { classIds: string[] }).classIds]),
    ).toEqual([['cal@example.com', [CLASS_C]]]);
  });

  it('never reminds a recipient taken off the lesson while the tick is sending', async () => {
    ctx.lesson(NOW + 60 * MINUTE);
    ctx.hooks.beforeSend = () => {
      ctx.booking.classes[0].customer_ids = [MEI_ID];
      ctx.booking.classes[0].instructor_id = BEN_ID;
    };
    await ctx.worker().tick();
    expect(recipients(ctx.mailer.sent)).toEqual([
      'booking.reminder.customer mei@example.com',
    ]);
  });

  it('never reminds once reminders are turned off while the tick is sending', async () => {
    ctx.lesson(NOW + 60 * MINUTE);
    ctx.hooks.beforeSend = () => {
      ctx.repo.settings.enabled = false;
    };
    await ctx.worker().tick();
    expect(ctx.mailer.sent).toHaveLength(1);
    expect(ctx.repo.sends).toHaveLength(1);
  });

  it('records a send that throws as failed', async () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    ctx.hooks.beforeSend = () => Promise.reject(new Error('resend down'));
    ctx.lesson(NOW + 60 * MINUTE, { customer_ids: [MEI_ID] });
    await expect(ctx.worker().tick()).resolves.toEqual({
      sent: 0,
      skipped: 0,
      failed: 2,
    });
    expect(ctx.repo.sends.map((s) => s.status)).toEqual(['failed', 'failed']);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('failed: resend down'),
    );
  });

  it('logs and stops the tick when the database fails', async () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    ctx.repo.remindableClassesStartingBetween = () =>
      Promise.reject(new Error('down'));
    await expect(ctx.worker().tick()).resolves.toEqual({
      sent: 0,
      skipped: 0,
      failed: 0,
    });
    expect(error).toHaveBeenCalledWith('Lesson reminders failed: down');
  });

  it('never claims or sends a reminder still waiting in the queue at shutdown', async () => {
    jest.useFakeTimers({ now: NOW });
    const held: (() => Promise<unknown>)[] = [];
    const queue = {
      enqueue: (job: () => Promise<unknown>) => held.push(job) > 0,
    } as unknown as BookingEmailQueue;
    ctx.lesson(NOW + 60 * MINUTE);
    const worker = ctx.worker(queue);
    void worker.tick();
    await jest.advanceTimersByTimeAsync(0);
    expect(held).toHaveLength(1);
    expect(ctx.repo.sends).toEqual([]);
    const stopped = worker.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(LESSON_REMINDERS_DRAIN_MS);
    await stopped;
    await held[0]();
    expect(ctx.repo.sends).toEqual([]);
    expect(ctx.mailer.sent).toEqual([]);
  });

  it('polls only in the worker process group', async () => {
    jest.useFakeTimers({ now: NOW });
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    ctx.lesson(NOW + 60 * MINUTE + LESSON_REMINDERS_INTERVAL_MS);
    ctx.clock.value += LESSON_REMINDERS_INTERVAL_MS;
    ctx.env[PROCESS_GROUP_KEY] = 'app';
    const web = ctx.worker();
    web.onModuleInit();
    await jest.advanceTimersByTimeAsync(LESSON_REMINDERS_INTERVAL_MS);
    expect(ctx.mailer.sent).toEqual([]);
    await web.onModuleDestroy();

    ctx.env[PROCESS_GROUP_KEY] = 'worker';
    const background = ctx.worker();
    background.onModuleInit();
    await jest.advanceTimersByTimeAsync(LESSON_REMINDERS_INTERVAL_MS);
    expect(ctx.mailer.sent).toHaveLength(3);
    await background.onModuleDestroy();
  });
});
