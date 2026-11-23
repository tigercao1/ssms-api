import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { resolveEmailLanguage } from '../mailer/email-language';
import { MailerService } from '../mailer/mailer.service';
import type {
  BookingEmailVars,
  BookingCustomerUpdateChanges,
  BookingDetailChanges,
  BookingLessonTime,
  BookingUpdateChanges,
  EmailAttachment,
  EmailLanguage,
  EmailTemplate,
  SendEmailRequest,
} from '../mailer/mailer.types';
import { BOOKING_CLOCK, type BookingClock } from './booking-calendars.service';
import { BookingEmailQueue } from './booking-email-queue';
import {
  buildIcs,
  classUid,
  type IcsMethod,
  type IcsPerson,
  icsContentType,
} from './booking-ics';
import { BookingRepository, type ClassNoticeRow } from './booking.repository';

export type BookingWarningCode =
  | 'customer_email_missing'
  | 'instructor_email_missing';

export interface BookingWarning {
  code: BookingWarningCode;
  message: string;
  customerId?: string;
  instructorId?: string;
}

export const CUSTOMER_EMAIL_MISSING =
  'The customer has no email address, so no booking email was sent';
export const INSTRUCTOR_EMAIL_MISSING =
  'The instructor has no email address, so no booking email was sent';

type BookingEmailKind = 'confirmed' | 'rescheduled' | 'updated' | 'cancelled';
export type Audience = 'customer' | 'instructor';

export interface Recipient {
  audience: Audience;
  id: string;
  email: string | null;
  displayName: string | null;
  fullName: string | null;
  language: EmailLanguage;
}

interface Delivery {
  kind: BookingEmailKind;
  recipient: Recipient;
  notices: ClassNoticeRow[];
  sequence?: number;
  previous?: ClassNoticeRow;
  changes?: BookingUpdateChanges | BookingCustomerUpdateChanges;
}

interface PendingEmail {
  delivery: Delivery;
  to: string;
}

export const BOOKING_EMAIL_DRAIN_MS = 3_000;
export const BOOKING_EMAIL_UNSENT_LOG_MS = 1_000;
const SHUTDOWN_REASON = 'shutdown';

const DEFAULT_LESSON_NAME = 'Lesson';
const CUSTOMER_LANGUAGE: EmailLanguage = 'en';
const ORGANIZER_NAME = 'Serendipity Snow Club';

@Injectable()
export class BookingEmailsService implements OnModuleDestroy {
  private readonly logger = new Logger(BookingEmailsService.name);

  constructor(
    private readonly repo: BookingRepository,
    private readonly mailer: MailerService,
    private readonly queue: BookingEmailQueue<PendingEmail>,
    @Inject(BOOKING_CLOCK) private readonly clock: BookingClock,
  ) {}

  async onModuleDestroy(): Promise<void> {
    const unsent = await this.queue.close(BOOKING_EMAIL_DRAIN_MS);
    if (unsent.length === 0) {
      return;
    }
    this.logger.warn(
      `Shutting down with ${unsent.length} booking email(s) unsent`,
    );
    await this.recordUnsent(
      unsent.map(({ payload, started }) => ({ ...payload, started })),
    );
  }

  async snapshot(classId: string): Promise<ClassNoticeRow | null> {
    const [notice] = await this.load([classId]);
    return notice ?? null;
  }

  async booked(classIds: string[]): Promise<BookingWarning[]> {
    const notices = this.upcoming(await this.load(classIds));
    if (notices.length === 0) {
      return [];
    }
    return this.deliverAll(
      recipientsOf(notices[0]).map((recipient) => ({
        kind: 'confirmed',
        recipient,
        notices,
      })),
    );
  }

  async rescheduled(
    before: ClassNoticeRow | null,
    classId: string,
  ): Promise<BookingWarning[]> {
    const [after] = this.upcoming(await this.load([classId]));
    if (!before || !after) {
      return [];
    }
    const previous = new Map(recipientsOf(before).map((r) => [keyOf(r), r]));
    const current = new Map(recipientsOf(after).map((r) => [keyOf(r), r]));
    const moved = changed(before, after);
    const regrouped = !sameCustomers(before, after);
    const deliveries: Delivery[] = [];
    for (const [key, recipient] of previous) {
      if (!current.has(key)) {
        deliveries.push({
          kind: 'cancelled',
          recipient,
          notices: [before],
          sequence: Math.max(after.ics_sequence, before.ics_sequence + 1),
        });
      }
    }
    for (const [key, recipient] of current) {
      if (!previous.has(key)) {
        deliveries.push({ kind: 'confirmed', recipient, notices: [after] });
      } else if (
        recipient.audience === 'instructor' &&
        sameTime(before, after) &&
        (moved || regrouped)
      ) {
        deliveries.push({
          kind: 'updated',
          recipient,
          notices: [after],
          changes: changesOf(before, after),
        });
      } else if (moved && sameTime(before, after)) {
        deliveries.push({
          kind: 'updated',
          recipient,
          notices: [after],
          changes: customerChangesOf(before, after),
        });
      } else if (moved) {
        deliveries.push({
          kind: 'rescheduled',
          recipient,
          notices: [after],
          previous: before,
        });
      }
    }
    return this.deliverAll(deliveries);
  }

  async cancelled(classId: string): Promise<BookingWarning[]> {
    const [notice] = this.upcoming(await this.load([classId]));
    if (!notice) {
      return [];
    }
    return this.deliverAll(
      recipientsOf(notice).map((recipient) => ({
        kind: 'cancelled',
        recipient,
        notices: [notice],
      })),
    );
  }

  private async load(ids: string[]): Promise<ClassNoticeRow[]> {
    try {
      return await this.repo.findClassNotices(ids);
    } catch (err) {
      this.logger.error(
        `Could not load classes for booking emails: ${messageOf(err)}`,
      );
      return [];
    }
  }

  private upcoming(notices: ClassNoticeRow[]): ClassNoticeRow[] {
    const now = this.clock.now();
    return notices.filter((n) => Date.parse(n.starts_at) >= now);
  }

  private async deliverAll(deliveries: Delivery[]): Promise<BookingWarning[]> {
    const warnings: BookingWarning[] = [];
    const unsent: (PendingEmail & { started: boolean })[] = [];
    for (const delivery of deliveries) {
      const to = delivery.recipient.email;
      if (to) {
        const queued = this.queue.enqueue(
          () => this.mailer.send(this.request(delivery, to)),
          { delivery, to },
        );
        if (!queued) {
          unsent.push({ delivery, to, started: false });
        }
      } else {
        warnings.push(missingEmail(delivery.recipient));
      }
    }
    if (unsent.length > 0) {
      for (const { delivery } of unsent) {
        this.logger.warn(
          `Booking email queue closed; recording ${templateOf(delivery)} for class(es) ${delivery.notices.map((n) => n.id).join(', ')} as unsent`,
        );
      }
      await this.recordUnsent(unsent);
    }
    return warnings;
  }

  private async recordUnsent(
    emails: (PendingEmail & { started: boolean })[],
  ): Promise<void> {
    let deadline: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      this.mailer.recordUnsent(
        emails.map(({ delivery, to, started }) => {
          const request = this.request(delivery, to);
          return { ...request, metadata: { ...request.metadata, started } };
        }),
        SHUTDOWN_REASON,
      ),
      new Promise<void>((resolve) => {
        deadline = setTimeout(resolve, BOOKING_EMAIL_UNSENT_LOG_MS);
      }),
    ]);
    clearTimeout(deadline);
  }

  private request(delivery: Delivery, to: string): SendEmailRequest {
    const { kind, recipient, notices } = delivery;
    const vars = emailVars(recipient, delivery);
    const template = templateOf(delivery);
    return {
      template,
      to,
      language: recipient.language,
      vars,
      mode: 'background',
      instructorId: recipient.audience === 'instructor' ? recipient.id : null,
      metadata: {
        booking: kind,
        classIds: notices.map((n) => n.id),
        ...(recipient.audience === 'customer'
          ? { customerId: recipient.id }
          : {}),
      },
      idempotencyKey: idempotencyKey(delivery),
      ...(onGoogleCalendar(delivery)
        ? {}
        : { attachments: [this.ics(delivery, template)] }),
    };
  }

  private ics(delivery: Delivery, template: EmailTemplate): EmailAttachment {
    const { kind, recipient, notices } = delivery;
    const method: IcsMethod = kind === 'cancelled' ? 'CANCEL' : 'REQUEST';
    const stamp = new Date(this.clock.now());
    const organizer: IcsPerson = {
      email: this.mailer.senderAddress(template),
      name: ORGANIZER_NAME,
    };
    return {
      filename: notices.length > 1 ? 'lessons.ics' : 'lesson.ics',
      contentType: icsContentType(method),
      content: Buffer.from(
        buildIcs({
          method,
          stamp,
          organizer,
          events: notices.map((notice) => ({
            uid: classUid(notice.id),
            sequence: sequenceOf(delivery, notice),
            start: new Date(notice.starts_at),
            end: new Date(notice.ends_at),
            summary: summaryFor(recipient.audience, notice),
            location: notice.location?.name ?? null,
            attendees: attendeesOf(notice, recipient),
          })),
        }),
        'utf8',
      ),
    };
  }
}

function onGoogleCalendar({ recipient, notices }: Delivery): boolean {
  return (
    recipient.audience === 'instructor' &&
    notices.every((n) => n.google_calendar_id)
  );
}

function sequenceOf(delivery: Delivery, notice: ClassNoticeRow): number {
  return delivery.sequence ?? notice.ics_sequence;
}

function idempotencyKey(delivery: Delivery): string {
  const { kind, recipient, notices } = delivery;
  const lessons = notices
    .map((n) => `${n.id}.${sequenceOf(delivery, n)}`)
    .sort()
    .join(',');
  const digest = createHash('sha256').update(lessons).digest('hex');
  return ['booking', kind, recipient.audience, recipient.id, digest].join(':');
}

export function recipientsOf(notice: ClassNoticeRow): Recipient[] {
  const customers: Recipient[] = (notice.participants ?? [])
    .filter((p) => p.customer)
    .map((p) => ({
      audience: 'customer',
      id: p.customer_id,
      email: p.customer!.email?.trim() || null,
      displayName:
        p.customer!.first_name?.trim() || p.customer!.last_name?.trim() || null,
      fullName: fullName(p.customer!),
      language: CUSTOMER_LANGUAGE,
    }));
  const instructor = notice.instructor;
  return [
    ...customers,
    {
      audience: 'instructor',
      id: notice.instructor_id,
      email: instructor?.email?.trim() || null,
      displayName: instructor?.display_name_en ?? null,
      fullName: instructor?.display_name_en ?? null,
      language: resolveEmailLanguage(instructor?.preferred_language),
    },
  ];
}

function attendeesOf(
  notice: ClassNoticeRow,
  recipient: Recipient,
): IcsPerson[] {
  const attendees =
    recipient.audience === 'instructor' ? recipientsOf(notice) : [recipient];
  return attendees
    .filter((r): r is Recipient & { email: string } => Boolean(r.email))
    .map((r) => ({ email: r.email, name: r.fullName }));
}

function emailVars(
  recipient: Recipient,
  delivery: Delivery,
): BookingEmailVars & {
  previous?: BookingLessonTime[];
  changes?: BookingUpdateChanges | BookingCustomerUpdateChanges;
} {
  return {
    ...lessonVars(recipient, delivery.notices),
    ...(delivery.previous ? { previous: [timeOf(delivery.previous)] } : {}),
    ...(delivery.changes ? { changes: delivery.changes } : {}),
    ...(onGoogleCalendar(delivery) ? { onGoogleCalendar: true } : {}),
  };
}

export function lessonVars(
  recipient: Recipient,
  notices: ClassNoticeRow[],
): BookingEmailVars {
  const first = notices[0];
  return {
    displayName: recipient.displayName,
    lessonNameEn: first.lesson_type?.name_en ?? DEFAULT_LESSON_NAME,
    lessonNameZh: first.lesson_type?.name_zh ?? null,
    instructorNameEn: first.instructor?.display_name_en ?? '',
    instructorNameZh: first.instructor?.display_name_zh ?? null,
    customerNames:
      recipient.audience === 'instructor' ? customerNames(first) : [],
    location: first.location?.name ?? null,
    lessons: notices.map(timeOf),
  };
}

function summaryFor(audience: Audience, notice: ClassNoticeRow): string {
  const lesson = notice.lesson_type?.name_en ?? DEFAULT_LESSON_NAME;
  const other =
    audience === 'customer'
      ? notice.instructor?.display_name_en
      : customerNames(notice).join(', ');
  return other ? `${lesson} · ${other}` : lesson;
}

function customerNames(
  notice: ClassNoticeRow,
  excluding: ClassNoticeRow | null = null,
): string[] {
  const skip = new Set(excluding ? customerIdsOf(excluding) : []);
  return (notice.participants ?? [])
    .filter((p) => !skip.has(p.customer_id))
    .map((p) => (p.customer ? fullName(p.customer) : null))
    .filter((n): n is string => Boolean(n));
}

function detailChangesOf(
  before: ClassNoticeRow,
  after: ClassNoticeRow,
): BookingDetailChanges {
  return {
    ...(before.lesson_type?.name_en !== after.lesson_type?.name_en
      ? {
          lessonType: {
            previousEn: before.lesson_type?.name_en ?? DEFAULT_LESSON_NAME,
            previousZh: before.lesson_type?.name_zh ?? null,
          },
        }
      : {}),
  };
}

function changesOf(
  before: ClassNoticeRow,
  after: ClassNoticeRow,
): BookingUpdateChanges {
  return {
    addedCustomers: customerNames(after, before),
    removedCustomers: customerNames(before, after),
    ...detailChangesOf(before, after),
  };
}

function customerChangesOf(
  before: ClassNoticeRow,
  after: ClassNoticeRow,
): BookingCustomerUpdateChanges {
  return {
    ...detailChangesOf(before, after),
    ...(before.instructor_id !== after.instructor_id
      ? {
          instructor: {
            previousEn: before.instructor?.display_name_en ?? '',
            previousZh: before.instructor?.display_name_zh ?? null,
          },
        }
      : {}),
  };
}

function timeOf(notice: ClassNoticeRow): BookingLessonTime {
  return { startsAt: notice.starts_at, endsAt: notice.ends_at };
}

function sameTime(before: ClassNoticeRow, after: ClassNoticeRow): boolean {
  return (
    Date.parse(before.starts_at) === Date.parse(after.starts_at) &&
    Date.parse(before.ends_at) === Date.parse(after.ends_at)
  );
}

function sameCustomers(before: ClassNoticeRow, after: ClassNoticeRow): boolean {
  const previous = new Set(customerIdsOf(before));
  const current = customerIdsOf(after);
  return (
    previous.size === new Set(current).size &&
    current.every((id) => previous.has(id))
  );
}

function customerIdsOf(notice: ClassNoticeRow): string[] {
  return (notice.participants ?? []).map((p) => p.customer_id);
}

function changed(before: ClassNoticeRow, after: ClassNoticeRow): boolean {
  return (
    !sameTime(before, after) ||
    before.instructor_id !== after.instructor_id ||
    before.location?.name !== after.location?.name ||
    before.lesson_type?.name_en !== after.lesson_type?.name_en
  );
}

function keyOf(recipient: Recipient): string {
  return `${recipient.audience}:${recipient.id}`;
}

function missingEmail(recipient: Recipient): BookingWarning {
  return recipient.audience === 'customer'
    ? {
        code: 'customer_email_missing',
        message: CUSTOMER_EMAIL_MISSING,
        customerId: recipient.id,
      }
    : {
        code: 'instructor_email_missing',
        message: INSTRUCTOR_EMAIL_MISSING,
        instructorId: recipient.id,
      };
}

function fullName(c: {
  first_name: string | null;
  last_name: string | null;
}): string | null {
  return (
    [c.first_name?.trim(), c.last_name?.trim()].filter((p) => p).join(' ') ||
    null
  );
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function templateOf({ kind, recipient }: Delivery): EmailTemplate {
  return `booking.${kind}.${recipient.audience}` as const satisfies EmailTemplate;
}
