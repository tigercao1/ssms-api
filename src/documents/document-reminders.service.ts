import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { AUDIT_ACTIONS, type AuditActor } from '../audit/audit.types';
import {
  CertificationExpiryService,
  type CertificationExpiryResult,
} from './certification-expiry.service';
import { utcToday } from './certification-validity';
import { DocumentAssignmentsRepository } from './document-assignments.repository';
import { ASSIGNMENT_NOT_FOUND } from './document-assignments.service';
import { DocumentNotificationsService } from './document-notifications.service';
import { DocumentSubjectsRepository } from './document-subjects.repository';
import type {
  DocumentAssignmentRow,
  DocumentInstructorRow,
} from './documents.types';

const DAY_MS = 24 * 60 * 60 * 1000;
/** An assignment is reminded when it is this old and was not reminded for this long. */
export const REMINDER_INTERVAL_MS = 7 * DAY_MS;
/** Tolerance for the daily cron starting a little earlier than a week ago. */
export const REMINDER_SLACK_MS = 60 * 60 * 1000;

export const ASSIGNMENT_NOT_OPEN = 'Only open assignments can be reminded';
export const ASSIGNMENT_NOT_INSTRUCTOR =
  'Only instructor assignments can be reminded';

/** Counts from one open-assignment reminder pass. */
export interface AssignmentRemindersResult {
  /** Open assignments that were due a reminder. */
  due: number;
  /** Of those, how many were emailed and stamped `reminder_sent_at`. */
  reminded: number;
  /** Reminder emails sent (one per instructor, listing all their due assignments). */
  emails: number;
}

/** `POST /internal/documents/reminders` response: one entry per daily job. */
export interface DailyRemindersResult {
  documents: AssignmentRemindersResult;
  certifications: CertificationExpiryResult;
}

/**
 * Onboarding reminders: the daily job behind `POST /internal/documents/reminders`
 * and the admin "remind" action on a single assignment.
 */
@Injectable()
export class DocumentRemindersService {
  private readonly logger = new Logger(DocumentRemindersService.name);

  constructor(
    private readonly assignments: DocumentAssignmentsRepository,
    private readonly subjects: DocumentSubjectsRepository,
    private readonly notifications: DocumentNotificationsService,
    private readonly audit: AuditService,
    private readonly certificationExpiry: CertificationExpiryService,
  ) {}

  /** Runs every daily reminder job and returns each job's counts. */
  async run(now: Date = new Date()): Promise<DailyRemindersResult> {
    return {
      documents: await this.remindOpenAssignments(now),
      certifications: await this.certificationExpiry.run(utcToday(now), now),
    };
  }

  /**
   * Emails each instructor once about all of their open assignments that are
   * over 7 days old and were not reminded in the last 7 days, then stamps
   * `reminder_sent_at` on those assignments. Assignments of inactive
   * instructors or inactive templates are left alone. A failed email leaves
   * its assignments due, so the next run retries them.
   */
  async remindOpenAssignments(now: Date): Promise<AssignmentRemindersResult> {
    const cutoff = new Date(
      now.getTime() - REMINDER_INTERVAL_MS + REMINDER_SLACK_MS,
    );
    const due = (
      await this.assignments.listDueForReminder('instructor', cutoff)
    ).filter((row) => row.template?.is_active);
    const byInstructor = new Map<string, DocumentAssignmentRow[]>();
    for (const row of due) {
      byInstructor.set(row.subject_id, [
        ...(byInstructor.get(row.subject_id) ?? []),
        row,
      ]);
    }
    const result: AssignmentRemindersResult = {
      due: due.length,
      reminded: 0,
      emails: 0,
    };
    const day = utcToday(now);
    for (const [instructorId, rows] of byInstructor) {
      try {
        const instructor = await this.subjects.findInstructor(instructorId);
        if (!instructor?.is_active) {
          continue;
        }
        if (
          await this.remind(
            instructor,
            rows,
            now,
            `documents.reminder/${instructorId}/${day}`,
          )
        ) {
          result.emails += 1;
          result.reminded += rows.length;
        }
      } catch (err) {
        this.logger.error(
          `Reminding instructor ${instructorId} failed: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    this.logger.log(
      `Document reminders: ${result.due} due, ${result.reminded} reminded in ` +
        `${result.emails} email(s).`,
    );
    return result;
  }

  /**
   * `POST /admin/documents/assignments/:id/remind`: validates and audits, then
   * emails the reminder in the background. 404 unknown, 400 not an instructor
   * assignment, 409 completed or archived.
   */
  async remindOne(id: string, actor: AuditActor): Promise<void> {
    const row = await this.assignments.findById(id);
    if (!row) {
      throw new NotFoundException(ASSIGNMENT_NOT_FOUND);
    }
    if (row.subject_type !== 'instructor') {
      throw new BadRequestException(ASSIGNMENT_NOT_INSTRUCTOR);
    }
    if (row.status !== 'assigned' && row.status !== 'viewed') {
      throw new ConflictException(ASSIGNMENT_NOT_OPEN);
    }
    const instructor = await this.subjects.findInstructor(row.subject_id);
    if (!instructor) {
      throw new NotFoundException(ASSIGNMENT_NOT_FOUND);
    }
    await this.audit.record({
      action: AUDIT_ACTIONS.documentAssignmentRemind,
      actor: { ...actor, role: 'admin' },
      targetType: 'document_assignment',
      targetId: id,
      metadata: {
        templateId: row.template_id,
        subjectId: row.subject_id,
        season: row.season,
        previousReminderAt: row.reminder_sent_at,
      },
    });
    void this.remind(instructor, [row], new Date()).catch((err: unknown) => {
      this.logger.error(
        `Reminding assignment ${id} failed: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  private async remind(
    instructor: DocumentInstructorRow,
    rows: DocumentAssignmentRow[],
    now: Date,
    idempotencyKey?: string,
  ): Promise<boolean> {
    const outcome = await this.notifications.sendReminder(
      instructor,
      rows,
      idempotencyKey,
    );
    if (outcome !== 'sent') {
      return false;
    }
    const at = now.toISOString();
    for (const row of rows) {
      await this.assignments.update(row.id, { reminder_sent_at: at });
    }
    return true;
  }
}
