import { Inject, Injectable, Logger } from '@nestjs/common';
import { resolveEmailLanguage } from '../mailer/email-language';
import { MailerService } from '../mailer/mailer.service';
import type {
  BookingEmailVars,
  BookingLessonTime,
  EmailLanguage,
  EmailTemplate,
} from '../mailer/mailer.types';
import { BOOKING_CLOCK, type BookingClock } from './booking-calendars.service';
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

type BookingEmailKind = 'confirmed' | 'rescheduled' | 'cancelled';
type Audience = 'customer' | 'instructor';

interface Recipient {
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
}

const DEFAULT_LESSON_NAME = 'Lesson';
const CUSTOMER_LANGUAGE: EmailLanguage = 'en';
const ORGANIZER_NAME = 'Serendipity Snow Club';

@Injectable()
export class BookingEmailsService {
  private readonly logger = new Logger(BookingEmailsService.name);

  constructor(
    private readonly repo: BookingRepository,
    private readonly mailer: MailerService,
    @Inject(BOOKING_CLOCK) private readonly clock: BookingClock,
  ) {}

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
      } else if (moved) {
        deliveries.push({
          kind: 'rescheduled',
          recipient,
          notices: [after],
          previous: sameTime(before, after) ? undefined : before,
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

  private deliverAll(deliveries: Delivery[]): BookingWarning[] {
    const warnings: BookingWarning[] = [];
    for (const delivery of deliveries) {
      const { recipient } = delivery;
      if (recipient.email) {
        void this.deliver(delivery, recipient.email);
      } else {
        warnings.push(missingEmail(recipient));
      }
    }
    return warnings;
  }

  private deliver(delivery: Delivery, to: string): Promise<unknown> {
    const { kind, recipient, notices } = delivery;
    const method: IcsMethod = kind === 'cancelled' ? 'CANCEL' : 'REQUEST';
    const vars = emailVars(recipient, delivery);
    const template =
      `booking.${kind}.${recipient.audience}` as const satisfies EmailTemplate;
    const stamp = new Date(this.clock.now());
    const organizer: IcsPerson = {
      email: this.mailer.senderAddress(),
      name: ORGANIZER_NAME,
    };
    return this.mailer.send({
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
      idempotencyKey: [
        'booking',
        kind,
        recipient.audience,
        recipient.id,
        ...notices.map((n) => `${n.id}.${delivery.sequence ?? n.ics_sequence}`),
      ].join(':'),
      attachments: notices.map((notice, index) => ({
        filename: notices.length > 1 ? `lesson-${index + 1}.ics` : 'lesson.ics',
        contentType: icsContentType(method),
        content: Buffer.from(
          buildIcs({
            method,
            uid: classUid(notice.id),
            sequence: delivery.sequence ?? notice.ics_sequence,
            stamp,
            start: new Date(notice.starts_at),
            end: new Date(notice.ends_at),
            summary: summaryFor(recipient.audience, notice),
            location: notice.location?.name ?? null,
            organizer,
            attendees: attendeesOf(notice),
          }),
          'utf8',
        ),
      })),
    });
  }
}

function recipientsOf(notice: ClassNoticeRow): Recipient[] {
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

function attendeesOf(notice: ClassNoticeRow): IcsPerson[] {
  return recipientsOf(notice)
    .filter((r): r is Recipient & { email: string } => Boolean(r.email))
    .map((r) => ({ email: r.email, name: r.fullName }));
}

function emailVars(
  recipient: Recipient,
  delivery: Delivery,
): BookingEmailVars & { previous?: BookingLessonTime[] } {
  const first = delivery.notices[0];
  return {
    displayName: recipient.displayName,
    lessonNameEn: first.lesson_type?.name_en ?? DEFAULT_LESSON_NAME,
    lessonNameZh: first.lesson_type?.name_zh ?? null,
    instructorNameEn: first.instructor?.display_name_en ?? '',
    instructorNameZh: first.instructor?.display_name_zh ?? null,
    customerNames: customerNames(first),
    location: first.location?.name ?? null,
    lessons: delivery.notices.map(timeOf),
    ...(delivery.previous ? { previous: [timeOf(delivery.previous)] } : {}),
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

function customerNames(notice: ClassNoticeRow): string[] {
  return (notice.participants ?? [])
    .map((p) => (p.customer ? fullName(p.customer) : null))
    .filter((n): n is string => Boolean(n));
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
