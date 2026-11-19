import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  runsBackgroundWorkers,
  runsOnProductionApp,
} from '../config/process-group';
import { MailerService } from '../mailer/mailer.service';
import type { SendEmailRequest, SendOutcome } from '../mailer/mailer.types';
import { BOOKING_CLOCK, type BookingClock } from './booking-calendars.service';
import { BookingEmailQueue } from './booking-email-queue';
import {
  BOOKING_EMAIL_DRAIN_MS,
  lessonVars,
  type Recipient,
  recipientsOf,
} from './booking-emails.service';
import {
  BookingRemindersRepository,
  type ReminderClaim,
  type ReminderClassRow,
  type ReminderOutcome,
} from './booking-reminders.repository';

export const LESSON_REMINDERS_FLAG = 'BOOKING_REMINDERS_ENABLED';
export const LESSON_REMINDERS_INTERVAL_MS = 60_000;
export const LESSON_REMINDER_STALE_CLAIM_MS = 15 * 60_000;
export const LESSON_REMINDERS_DRAIN_MS = BOOKING_EMAIL_DRAIN_MS + 1_000;
const MINUTE_MS = 60_000;

export type LessonRemindersRun = Record<ReminderOutcome, number>;

interface InFlight {
  id: string;
  started: boolean;
  released: boolean;
}

export function reminderDue(
  lesson: Pick<ReminderClassRow, 'starts_at' | 'starts_at_set_at'>,
  offsetMinutes: number,
  now: number,
  remindersEnabledAt: string,
): boolean {
  const start = Date.parse(lesson.starts_at);
  const dueAt = start - offsetMinutes * MINUTE_MS;
  return (
    dueAt <= now &&
    now < start &&
    dueAt >= Date.parse(lesson.starts_at_set_at) &&
    dueAt >= Date.parse(remindersEnabledAt)
  );
}

export function lessonRemindersEnabled(config: ConfigService): boolean {
  const raw = config.get<string>(LESSON_REMINDERS_FLAG)?.trim().toLowerCase();
  if (!raw) {
    return runsOnProductionApp(config);
  }
  return raw === 'true';
}

@Injectable()
export class BookingRemindersWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BookingRemindersWorker.name);
  private timer?: NodeJS.Timeout;
  private draining?: Promise<LessonRemindersRun>;
  private inFlight?: InFlight;
  private stopping = false;

  constructor(
    private readonly config: ConfigService,
    private readonly repo: BookingRemindersRepository,
    private readonly mailer: MailerService,
    private readonly queue: BookingEmailQueue,
    @Inject(BOOKING_CLOCK) private readonly clock: BookingClock,
  ) {}

  onModuleInit(): void {
    if (!runsBackgroundWorkers(this.config)) {
      this.logger.log(`Lesson reminders run in the worker process group`);
      return;
    }
    if (!lessonRemindersEnabled(this.config)) {
      this.logger.log(
        `Lesson reminders disabled: ${LESSON_REMINDERS_FLAG} is not "true" and this is not the production app`,
      );
      return;
    }
    this.logger.log(
      `Lesson reminders enabled; polling every ${LESSON_REMINDERS_INTERVAL_MS / 1000}s`,
    );
    this.timer = setInterval(
      () => void this.tick(),
      LESSON_REMINDERS_INTERVAL_MS,
    );
  }

  async onModuleDestroy(): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
    this.stopping = true;
    if (!this.draining) {
      return;
    }
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const finished = await Promise.race([
      this.draining.then(() => true),
      new Promise<boolean>((resolve) => {
        deadline = setTimeout(() => resolve(false), LESSON_REMINDERS_DRAIN_MS);
      }),
    ]);
    clearTimeout(deadline);
    const pending = this.inFlight;
    if (finished || !pending || pending.started) {
      return;
    }
    pending.released = true;
    try {
      await this.repo.release(pending.id);
      this.logger.warn(
        `Shutting down before lesson reminder ${pending.id} was sent; released it for another worker`,
      );
    } catch (err) {
      this.logger.error(
        `Could not release lesson reminder ${pending.id}: ${messageOf(err)}`,
      );
    }
  }

  tick(): Promise<LessonRemindersRun> {
    this.draining ??= this.run().finally(() => {
      this.draining = undefined;
    });
    return this.draining;
  }

  private async run(): Promise<LessonRemindersRun> {
    const result: LessonRemindersRun = { sent: 0, skipped: 0, failed: 0 };
    if (!lessonRemindersEnabled(this.config) || this.stopping) {
      return result;
    }
    try {
      const now = this.clock.now();
      await this.failStaleClaims(now);
      const settings = await this.repo.getSettings();
      const offsets = [...settings.offsets_minutes].sort((a, b) => a - b);
      if (!settings.enabled || offsets.length === 0) {
        return result;
      }
      const lessons = (
        await this.repo.remindableClassesStartingBetween(
          new Date(now).toISOString(),
          new Date(now + offsets[offsets.length - 1] * MINUTE_MS).toISOString(),
        )
      )
        .map((lesson) => ({
          lesson,
          due: offsets.filter((o) =>
            reminderDue(lesson, o, now, settings.enabled_at),
          ),
        }))
        .filter(({ due }) => due.length > 0);
      const claimed = new Set(
        (await this.repo.claimed(lessons.map(({ lesson }) => lesson.id))).map(
          claimKey,
        ),
      );
      for (const { lesson, due } of lessons) {
        const [shortest, ...superseded] = due;
        for (const recipient of recipientsOf(lesson)) {
          if (this.stopping) {
            return result;
          }
          const email = recipient.email;
          if (!email) {
            continue;
          }
          for (const offset of superseded) {
            const claim = claimOf(lesson, offset, recipient);
            if (
              !claimed.has(claimKey(claim)) &&
              (await this.repo.supersede(claim))
            ) {
              result.skipped += 1;
            }
          }
          if (claimed.has(claimKey(claimOf(lesson, shortest, recipient)))) {
            continue;
          }
          const outcome = await this.remind(lesson, shortest, recipient, email);
          if (outcome) {
            result[outcome] += 1;
          }
        }
      }
    } catch (err) {
      this.logger.error(`Lesson reminders failed: ${messageOf(err)}`);
    }
    return result;
  }

  private async remind(
    lesson: ReminderClassRow,
    offset: number,
    recipient: Recipient,
    email: string,
  ): Promise<ReminderOutcome | null> {
    const id = await this.repo.claim(claimOf(lesson, offset, recipient));
    if (!id) {
      return null;
    }
    const flight: InFlight = { id, started: false, released: false };
    this.inFlight = flight;
    try {
      const outcome = await this.send(
        flight,
        reminderRequest(lesson, offset, recipient, email),
      );
      if (!outcome) {
        if (!flight.released) {
          await this.repo.release(id);
        }
        return null;
      }
      await this.repo.finish(id, outcome);
      return outcome;
    } finally {
      this.inFlight = undefined;
    }
  }

  private async failStaleClaims(now: number): Promise<void> {
    const stale = await this.repo.failStaleClaims(
      new Date(now - LESSON_REMINDER_STALE_CLAIM_MS).toISOString(),
    );
    for (const claim of stale) {
      this.logger.warn(
        `Lesson reminder ${claim.id} (class ${claim.class_id}, ${claim.offset_minutes} min, ${claim.audience}) was still claimed after ${LESSON_REMINDER_STALE_CLAIM_MS / MINUTE_MS} minutes; marked failed: stale_claim`,
      );
    }
  }

  private send(
    flight: InFlight,
    request: SendEmailRequest,
  ): Promise<SendOutcome | null> {
    return new Promise((resolve) => {
      const queued = this.queue.enqueue(async () => {
        if (flight.released) {
          resolve(null);
          return;
        }
        flight.started = true;
        try {
          resolve(await this.mailer.send(request));
        } catch (err) {
          resolve('failed');
          throw err;
        }
      });
      if (!queued) {
        resolve(null);
      }
    });
  }
}

function claimOf(
  lesson: ReminderClassRow,
  offset: number,
  recipient: Recipient,
): ReminderClaim {
  return {
    class_id: lesson.id,
    starts_at: lesson.starts_at,
    offset_minutes: offset,
    audience: recipient.audience,
    recipient_id: recipient.id,
  };
}

function claimKey(claim: ReminderClaim): string {
  return [
    claim.class_id,
    Date.parse(claim.starts_at),
    claim.offset_minutes,
    claim.audience,
    claim.recipient_id,
  ].join(':');
}

function reminderRequest(
  lesson: ReminderClassRow,
  offset: number,
  recipient: Recipient,
  to: string,
): SendEmailRequest {
  return {
    template:
      recipient.audience === 'customer'
        ? 'booking.reminder.customer'
        : 'booking.reminder.instructor',
    to,
    language: recipient.language,
    vars: lessonVars(recipient, [lesson]),
    mode: 'background',
    instructorId: recipient.audience === 'instructor' ? recipient.id : null,
    metadata: {
      booking: 'reminder',
      classIds: [lesson.id],
      offsetMinutes: offset,
      ...(recipient.audience === 'customer'
        ? { customerId: recipient.id }
        : {}),
    },
    idempotencyKey: [
      'booking',
      'reminder',
      lesson.id,
      Date.parse(lesson.starts_at),
      offset,
      recipient.audience,
      recipient.id,
    ].join(':'),
  };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
