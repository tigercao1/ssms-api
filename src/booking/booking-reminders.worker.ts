import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { runsBackgroundWorkers } from '../config/process-group';
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
import { BookingReminderSettingsService } from './booking-reminder-settings.service';
import {
  BookingRemindersRepository,
  type ReminderClassRow,
  type ReminderOutcome,
} from './booking-reminders.repository';

export const LESSON_REMINDERS_FLAG = 'BOOKING_REMINDERS_ENABLED';
export const LESSON_REMINDERS_INTERVAL_MS = 60_000;
export const LESSON_REMINDER_GRACE_MS = 5 * 60_000;
export const LESSON_REMINDERS_DRAIN_MS = BOOKING_EMAIL_DRAIN_MS + 1_000;
const MINUTE_MS = 60_000;

export type LessonRemindersRun = Record<ReminderOutcome, number>;

interface InFlight {
  id: string;
  started: boolean;
  released: boolean;
}

export function reminderDue(
  startsAt: string,
  offsetMinutes: number,
  now: number,
): boolean {
  const start = Date.parse(startsAt);
  const dueAt = start - offsetMinutes * MINUTE_MS;
  return start > now && dueAt <= now && now - dueAt < LESSON_REMINDER_GRACE_MS;
}

export function lessonRemindersEnabled(config: ConfigService): boolean {
  const raw = config.get<string>(LESSON_REMINDERS_FLAG)?.trim().toLowerCase();
  if (!raw) {
    return config.get<string>('NODE_ENV') === 'production';
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
    private readonly settings: BookingReminderSettingsService,
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
        `Lesson reminders disabled: ${LESSON_REMINDERS_FLAG} is not "true"`,
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
      const settings = await this.settings.get();
      if (!settings.enabled) {
        return result;
      }
      const now = this.clock.now();
      for (const offset of settings.offsetsMinutes) {
        const lead = offset * MINUTE_MS;
        const lessons = await this.repo.classesStartingBetween(
          new Date(now + lead - LESSON_REMINDER_GRACE_MS).toISOString(),
          new Date(now + lead).toISOString(),
        );
        for (const lesson of lessons) {
          if (!remindable(lesson, offset, now)) {
            continue;
          }
          for (const recipient of recipientsOf(lesson)) {
            if (this.stopping) {
              return result;
            }
            const outcome = await this.remind(lesson, offset, recipient);
            if (outcome) {
              result[outcome] += 1;
            }
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
  ): Promise<ReminderOutcome | null> {
    if (!recipient.email) {
      return null;
    }
    const id = await this.repo.claim({
      class_id: lesson.id,
      starts_at: lesson.starts_at,
      offset_minutes: offset,
      audience: recipient.audience,
      recipient_id: recipient.id,
    });
    if (!id) {
      return null;
    }
    const flight: InFlight = { id, started: false, released: false };
    this.inFlight = flight;
    try {
      const outcome = await this.send(
        flight,
        reminderRequest(lesson, offset, recipient, recipient.email),
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

function remindable(
  lesson: ReminderClassRow,
  offset: number,
  now: number,
): boolean {
  return (
    lesson.status === 'scheduled' &&
    lesson.send_emails &&
    reminderDue(lesson.starts_at, offset, now)
  );
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
