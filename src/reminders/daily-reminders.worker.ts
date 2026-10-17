import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { InviteDeliveryResult } from '../activation/invite-delivery';
import { InviteRemindersService } from '../activation/invite-reminders.service';
import {
  CertificationExpiryService,
  type CertificationExpiryResult,
} from '../documents/certification-expiry.service';
import { torontoHour, torontoToday } from '../documents/certification-validity';
import {
  DocumentRemindersService,
  type AssignmentRemindersResult,
} from '../documents/document-reminders.service';
import { SeasonsService } from '../seasons/seasons.service';
import {
  DailyReminderRunsRepository,
  type ReminderPartOutcome,
} from './daily-reminder-runs.repository';

export const REMINDERS_ENABLED_KEY = 'REMINDERS_SCHEDULE_ENABLED';
export const REMINDERS_HOUR_KEY = 'REMINDERS_HOUR_TORONTO';
export const DEFAULT_REMINDERS_HOUR = 11;
export const REMINDERS_TICK_MS = 10 * 60_000;
export const REMINDERS_LEASE_SECONDS = 30 * 60;
export const MAX_REMINDERS_ERROR_LENGTH = 2_000;

export type ReminderPart<T> =
  | { ok: true; result: T }
  | { ok: false; error: string };

export interface InviteRemindersOutcome {
  season: string | null;
  delivery: InviteDeliveryResult | null;
}

export interface DailyRemindersSummary {
  day: string;
  documents: ReminderPart<AssignmentRemindersResult>;
  certifications: ReminderPart<CertificationExpiryResult>;
  invites: ReminderPart<InviteRemindersOutcome>;
}

export type DailyRemindersTick =
  | { outcome: 'off' | 'early' | 'skipped' }
  | { outcome: 'failed'; error: string }
  | { outcome: 'ran'; summary: DailyRemindersSummary };

export function remindersScheduleEnabled(config: ConfigService): boolean {
  const raw = config.get<string>(REMINDERS_ENABLED_KEY)?.trim().toLowerCase();
  if (!raw) {
    return config.get<string>('NODE_ENV') === 'production';
  }
  return raw === 'true';
}

export function remindersHour(config: ConfigService): number | null {
  const raw = config.get<string>(REMINDERS_HOUR_KEY)?.trim();
  if (!raw) {
    return DEFAULT_REMINDERS_HOUR;
  }
  const hour = Number(raw);
  return Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : null;
}

@Injectable()
export class DailyRemindersWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DailyRemindersWorker.name);
  private timer?: NodeJS.Timeout;
  private draining?: Promise<DailyRemindersTick>;

  constructor(
    private readonly config: ConfigService,
    private readonly runs: DailyReminderRunsRepository,
    private readonly documents: DocumentRemindersService,
    private readonly certifications: CertificationExpiryService,
    private readonly invites: InviteRemindersService,
    private readonly seasons: SeasonsService,
  ) {}

  scheduled(): boolean {
    return remindersScheduleEnabled(this.config) && this.hour() !== null;
  }

  onModuleInit(): void {
    if (!remindersScheduleEnabled(this.config)) {
      this.logger.log(
        `Daily reminders disabled: ${REMINDERS_ENABLED_KEY} is not "true"`,
      );
      return;
    }
    const hour = this.hour();
    if (hour === null) {
      this.logger.log(
        `Daily reminders disabled: ${REMINDERS_HOUR_KEY} is not an hour from 0 to 23`,
      );
      return;
    }
    this.logger.log(`Daily reminders scheduled at or after ${hour}:00 Toronto`);
    this.timer = setInterval(() => void this.tick(), REMINDERS_TICK_MS);
  }

  async onModuleDestroy(): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
    await this.draining;
  }

  tick(): Promise<DailyRemindersTick> {
    this.draining ??= this.run().finally(() => {
      this.draining = undefined;
    });
    return this.draining;
  }

  private hour(): number | null {
    return remindersHour(this.config);
  }

  private async run(): Promise<DailyRemindersTick> {
    const hour = this.hour();
    if (!remindersScheduleEnabled(this.config) || hour === null) {
      return { outcome: 'off' };
    }
    const now = new Date();
    if (torontoHour(now) < hour) {
      return { outcome: 'early' };
    }
    const day = torontoToday(now);
    let token: string | null;
    try {
      token = await this.runs.tryStart(day, REMINDERS_LEASE_SECONDS);
    } catch (err) {
      const error = messageOf(err);
      this.logger.error(`Daily reminders could not start: ${error}`);
      return { outcome: 'failed', error };
    }
    if (!token) {
      this.logger.debug(
        `Daily reminders for ${day} skipped: already ran or another run holds the lock`,
      );
      return { outcome: 'skipped' };
    }
    const summary: DailyRemindersSummary = {
      day,
      documents: await part(() => this.documents.remindOpenAssignments(now)),
      certifications: await part(() => this.certifications.run(day, now)),
      invites: await part(() => this.remindInvites()),
    };
    this.logger.log(summaryLine(summary));
    logInviteProblems(this.logger, summary.invites);
    try {
      const recorded = await this.runs.finish(token, {
        documents: outcomeOf(summary.documents, (r) => r.emails),
        certifications: outcomeOf(
          summary.certifications,
          (r) => r.expiring + r.expired,
        ),
        invites: outcomeOf(summary.invites, (r) => r.delivery?.sent ?? 0),
      });
      if (!recorded) {
        this.logger.warn(
          `Daily reminders for ${day} finished after losing the lease`,
        );
      }
    } catch (err) {
      this.logger.error(
        `Could not record the daily reminders for ${day}: ${messageOf(err)}`,
      );
    }
    return { outcome: 'ran', summary };
  }

  private async remindInvites(): Promise<InviteRemindersOutcome> {
    const season = await this.seasons.currentKey();
    if (!season) {
      return { season: null, delivery: null };
    }
    return { season, delivery: await this.invites.remind(season) };
  }
}

async function part<T>(job: () => Promise<T>): Promise<ReminderPart<T>> {
  try {
    return { ok: true, result: await job() };
  } catch (err) {
    return {
      ok: false,
      error: messageOf(err).slice(0, MAX_REMINDERS_ERROR_LENGTH),
    };
  }
}

function outcomeOf<T>(
  p: ReminderPart<T>,
  sent: (result: T) => number,
): ReminderPartOutcome {
  return p.ok
    ? { sent: sent(p.result), error: null }
    : { sent: null, error: p.error };
}

function describePart<T>(
  label: string,
  p: ReminderPart<T>,
  counts: (result: T) => string,
): string {
  return p.ok ? `${label} ${counts(p.result)}` : `${label} FAILED (${p.error})`;
}

export function summaryLine(summary: DailyRemindersSummary): string {
  return [
    `Daily reminders ${summary.day}:`,
    describePart(
      'documents',
      summary.documents,
      (r) => `${r.reminded}/${r.due} due reminded in ${r.emails} email(s);`,
    ),
    describePart(
      'certifications',
      summary.certifications,
      (r) =>
        `${r.expiring} expiring, ${r.expired} expired, ${r.failed} not sent;`,
    ),
    describePart('invites', summary.invites, ({ season, delivery }) =>
      delivery
        ? `${season}: ${delivery.sent}/${delivery.candidates} due reminded, ${delivery.failed.length} failed, ${delivery.skipped} skipped, ${delivery.needsReview.length} need review`
        : 'skipped: no current season',
    ),
  ].join(' ');
}

function logInviteProblems(
  logger: Logger,
  invites: ReminderPart<InviteRemindersOutcome>,
): void {
  const delivery = invites.ok ? invites.result.delivery : null;
  if (!delivery) {
    return;
  }
  for (const { inviteId, error } of delivery.failed) {
    logger.warn(`Invite reminder ${inviteId} failed: ${error}`);
  }
  if (delivery.needsReview.length > 0) {
    logger.warn(
      `Invite reminders claimed but never marked reminded: ${delivery.needsReview.join(', ')}`,
    );
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
