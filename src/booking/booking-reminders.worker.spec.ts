import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import {
  AMY_ID,
  BEN_ID,
  BLUE_ID,
  InMemoryBookingRemindersRepository,
  InMemoryBookingRepository,
  LEO_ID,
  MEI_ID,
} from '../../test/helpers/booking-fakes';
import { RecordingMailer } from '../../test/helpers/mailer-fakes';
import type { AuditService } from '../audit/audit.service';
import { PROCESS_GROUP_KEY } from '../config/process-group';
import type {
  BookingEmailVars,
  SendEmailRequest,
} from '../mailer/mailer.types';
import { BookingEmailQueue } from './booking-email-queue';
import { BookingReminderSettingsService } from './booking-reminder-settings.service';
import {
  BookingRemindersWorker,
  LESSON_REMINDER_GRACE_MS,
  LESSON_REMINDERS_DRAIN_MS,
  LESSON_REMINDERS_FLAG,
  LESSON_REMINDERS_INTERVAL_MS,
  reminderDue,
} from './booking-reminders.worker';

const MINUTE = 60_000;
const NOW = Date.parse('2026-12-10T17:00:00.000Z');
const CLASS_A = 'c0000000-0000-4000-8000-0000000000a1';
const CLASS_B = 'c0000000-0000-4000-8000-0000000000b2';
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
  const worker = (q: BookingEmailQueue = queue) =>
    new BookingRemindersWorker(
      config,
      repo,
      settings,
      mailer.asService(),
      q,
      clock,
    );
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
      ...overrides,
    });
  return { booking, repo, mailer, clock, env, queue, worker, lesson };
}

const recipients = (sent: SendEmailRequest[]) =>
  sent.map((r) => `${r.template} ${r.to}`).sort();

describe('reminderDue', () => {
  const start = NOW + 60 * MINUTE;

  it.each([
    ['exactly at start minus the offset', start, 60, true],
    ['a minute before it is due', start + MINUTE, 60, false],
    ['within the grace window', start - 4 * MINUTE, 60, true],
    [
      'just inside the grace window',
      start - LESSON_REMINDER_GRACE_MS + 1,
      60,
      true,
    ],
    [
      'once the grace window has passed',
      start - LESSON_REMINDER_GRACE_MS,
      60,
      false,
    ],
    ['a day-before reminder for a lesson an hour away', start, 1440, false],
    ['a lesson that already started', NOW - MINUTE, 15, false],
    ['a lesson starting right now', NOW, 15, false],
  ])('%s → %s', (_name, startsAt, offset, due) => {
    expect(reminderDue(at(startsAt), offset, NOW)).toBe(due);
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
    ctx.repo.settings.offsets_minutes = [2880, 180];
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
    [{ [LESSON_REMINDERS_FLAG]: 'false', NODE_ENV: 'production' }, 0],
    [{ NODE_ENV: 'development' }, 0],
    [{ NODE_ENV: 'production' }, 3],
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
        .map((r) => (r.vars as BookingEmailVars).lessons[0].startsAt),
    ).toEqual([at(moved), at(moved), at(moved)]);
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

  it('skips reminders that were already overdue, not sending them late', async () => {
    ctx.lesson(NOW + 30 * MINUTE);
    const worker = ctx.worker();
    await worker.tick();
    ctx.clock.value += MINUTE;
    await worker.tick();
    expect(ctx.mailer.sent).toEqual([]);
    expect(ctx.repo.sends).toEqual([]);
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

  it('releases the claim when the email queue is closed', async () => {
    await ctx.queue.close(0);
    ctx.lesson(NOW + 60 * MINUTE);
    await ctx.worker().tick();
    expect(ctx.mailer.sent).toEqual([]);
    expect(ctx.repo.sends).toEqual([]);
  });

  it('logs and stops the tick when the database fails', async () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    ctx.repo.classesStartingBetween = () => Promise.reject(new Error('down'));
    await expect(ctx.worker().tick()).resolves.toEqual({
      sent: 0,
      skipped: 0,
      failed: 0,
    });
    expect(error).toHaveBeenCalledWith('Lesson reminders failed: down');
  });

  it('releases a reminder still waiting in the queue at shutdown and never sends it', async () => {
    jest.useFakeTimers({ now: NOW });
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const held: (() => Promise<unknown>)[] = [];
    const queue = {
      enqueue: (job: () => Promise<unknown>) => held.push(job) > 0,
    } as unknown as BookingEmailQueue;
    ctx.lesson(NOW + 60 * MINUTE);
    const worker = ctx.worker(queue);
    void worker.tick();
    await jest.advanceTimersByTimeAsync(0);
    expect(held).toHaveLength(1);
    expect(ctx.repo.sends).toHaveLength(1);
    const stopped = worker.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(LESSON_REMINDERS_DRAIN_MS);
    await stopped;
    expect(ctx.repo.sends).toEqual([]);
    await held[0]();
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
