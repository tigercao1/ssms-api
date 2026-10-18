import { Injectable, Logger } from '@nestjs/common';
import {
  resolveEmailLanguage,
  withPortalLanguage,
} from '../mailer/email-language';
import { MailerService } from '../mailer/mailer.service';
import {
  CertificationUploadsRepository,
  type ExpiryCandidateRow,
  type ExpiryInstructorRow,
} from './certification-uploads.repository';
import {
  addDays,
  certificationKey,
  currentUploads,
  EXPIRED_REMINDER_GRACE_DAYS,
  EXPIRING_WITHIN_DAYS,
  type ExpiryReminder,
  expiryReminderDue,
  torontoStartOfDay,
  torontoToday,
} from './certification-validity';

export const CERTIFICATION_REUPLOAD_PATH = '/onboarding';

/** Counts from one {@link CertificationExpiryService.run}. */
export interface CertificationExpiryResult {
  expiring: number;
  expired: number;
  /** Emails not sent (failed or skipped); they are retried on the next run. */
  failed: number;
}

interface DueReminder {
  upload: ExpiryCandidateRow;
  instructor: ExpiryInstructorRow;
  stage: ExpiryReminder;
  level: number;
}

const instructorCertKey = (instructorId: string, org: string, track: string) =>
  `${instructorId}:${org}:${track}`;

/**
 * Daily certification expiry emails. For each instructor's current upload per
 * `(org, track)` that still matches a certification on their profile, sends
 * `certification.expiring` once when it is within 30 days of `valid_until` and
 * `certification.expired` once after it passes. `expiry_reminder_sent_at`
 * records the last one sent; which one it was is read by comparing its date to
 * `valid_until` (see `expiryReminderSent`). Only active, approved instructors
 * are emailed.
 */
@Injectable()
export class CertificationExpiryService {
  private readonly logger = new Logger(CertificationExpiryService.name);

  constructor(
    private readonly uploads: CertificationUploadsRepository,
    private readonly mailer: MailerService,
  ) {}

  /** Sends the expiry emails due on `today` (YYYY-MM-DD, Toronto). */
  async run(
    today = torontoToday(),
    now = new Date(),
    canSend?: () => Promise<boolean>,
  ): Promise<CertificationExpiryResult> {
    const result: CertificationExpiryResult = {
      expiring: 0,
      expired: 0,
      failed: 0,
    };
    const sentAt =
      torontoToday(now) === today
        ? now.toISOString()
        : torontoStartOfDay(today);
    for (const due of await this.dueReminders(today)) {
      if (canSend && !(await canSend())) {
        break;
      }
      const claimed = await this.uploads.swapExpiryReminderSentAt(
        due.upload.id,
        due.upload.expiry_reminder_sent_at,
        sentAt,
      );
      if (!claimed) {
        continue;
      }
      if ((await this.send(due)) === 'sent') {
        result[due.stage] += 1;
        continue;
      }
      result.failed += 1;
      await this.uploads.swapExpiryReminderSentAt(
        due.upload.id,
        sentAt,
        due.upload.expiry_reminder_sent_at,
      );
    }
    if (result.expiring + result.expired + result.failed > 0) {
      this.logger.log(
        `Certification expiry emails: ${result.expiring} expiring, ${result.expired} expired, ${result.failed} not sent`,
      );
    }
    return result;
  }

  private async dueReminders(today: string): Promise<DueReminder[]> {
    const rows = await this.uploads.listExpiryCandidates(
      addDays(today, -EXPIRED_REMINDER_GRACE_DAYS),
      addDays(today, EXPIRING_WITHIN_DAYS + 1),
    );
    const candidates = rows.flatMap((upload) => {
      const stage = expiryReminderDue(
        {
          reviewStatus: upload.review_status,
          validUntil: upload.valid_until,
          expiryReminderSentAt: upload.expiry_reminder_sent_at,
        },
        today,
      );
      return stage &&
        upload.instructor?.is_active &&
        upload.instructor.approval_status === 'approved'
        ? [{ upload, instructor: upload.instructor, stage }]
        : [];
    });
    if (candidates.length === 0) {
      return [];
    }
    const instructorIds = [
      ...new Set(candidates.map((c) => c.upload.instructor_id)),
    ];
    const [keys, certifications] = await Promise.all([
      this.uploads.listUploadKeys(instructorIds),
      this.uploads.listCertifications(instructorIds),
    ]);
    const currentIds = new Set<string>();
    for (const instructorId of instructorIds) {
      const current = currentUploads(
        keys
          .filter((k) => k.instructor_id === instructorId)
          .map((k) => ({ ...k, insertedAt: k.inserted_at })),
      );
      for (const upload of current.values()) {
        currentIds.add(upload.id);
      }
    }
    const levels = new Map(
      certifications.map((c) => [
        instructorCertKey(c.instructor_id, c.org, c.track),
        c.level,
      ]),
    );
    return candidates.flatMap((candidate) => {
      const { upload } = candidate;
      const level = levels.get(
        instructorCertKey(upload.instructor_id, upload.org, upload.track),
      );
      return currentIds.has(upload.id) && level !== undefined
        ? [{ ...candidate, level }]
        : [];
    });
  }

  private send({ upload, instructor, stage, level }: DueReminder) {
    const language = resolveEmailLanguage(instructor.preferred_language);
    return this.mailer.send({
      template:
        stage === 'expiring'
          ? 'certification.expiring'
          : 'certification.expired',
      to: instructor.email,
      language,
      vars: {
        displayName: instructor.display_name_en || undefined,
        org: upload.org,
        track: upload.track,
        level,
        validUntil: upload.valid_until,
        uploadUrl: withPortalLanguage(
          this.mailer.portalLink(CERTIFICATION_REUPLOAD_PATH),
          language,
        ),
      },
      mode: 'background',
      instructorId: instructor.id,
      authUserId: instructor.auth_user_id,
      metadata: {
        certificationUploadId: upload.id,
        certification: certificationKey(upload.org, upload.track),
        validUntil: upload.valid_until,
      },
      idempotencyKey: `certification.${stage}:${upload.id}:${upload.valid_until}`,
    });
  }
}
