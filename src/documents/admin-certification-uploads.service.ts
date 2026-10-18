import {
  ConflictException,
  GoneException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { AUDIT_ACTIONS, type AuditActor } from '../audit/audit.types';
import {
  resolveEmailLanguage,
  withPortalLanguage,
} from '../mailer/email-language';
import { MailerService } from '../mailer/mailer.service';
import { CERTIFICATION_REUPLOAD_PATH } from './certification-expiry.service';
import {
  CertificationUploadsRepository,
  type CertificationUploadWrite,
} from './certification-uploads.repository';
import { certificationKey, torontoToday } from './certification-validity';
import { DocumentSubjectsRepository } from './document-subjects.repository';
import type {
  CertUpload,
  CertificationFileUrl,
  CertificationUploadRow,
  DocumentInstructorRow,
  InstructorCertificationRow,
} from './documents.types';
import { toCertUploads } from './documents.presenters';
import type { ReviewCertificationUploadDto } from './dto/certification-upload.dto';
import { CERTIFICATION_UPLOAD_NOT_FOUND } from './me-certification-uploads.service';
import { PrivateStorageClient } from './private-storage.client';

export const REJECTED_CERTIFICATION_FILE_DELETED =
  'This certification upload was rejected and its file deleted';
export const REJECTED_CERTIFICATION_FINAL =
  'A rejected certification upload cannot be reviewed again; the instructor needs to upload a new file';

type ReviewedField = 'review_status' | 'review_note' | 'valid_until';

function pick(row: CertificationUploadRow, fields: ReviewedField[]) {
  return Object.fromEntries(fields.map((f) => [f, row[f]]));
}

/** Admin review of certification uploads: view the file, approve/reject, correct `validUntil`. */
@Injectable()
export class AdminCertificationUploadsService {
  private readonly logger = new Logger(AdminCertificationUploadsService.name);

  constructor(
    private readonly uploads: CertificationUploadsRepository,
    private readonly subjects: DocumentSubjectsRepository,
    private readonly storage: PrivateStorageClient,
    private readonly audit: AuditService,
    private readonly mailer: MailerService,
  ) {}

  /** Presigned GET of the uploaded file (served inline). Audited. */
  async fileUrl(id: string, actor: AuditActor): Promise<CertificationFileUrl> {
    const row = await this.load(id);
    if (row.review_status === 'rejected') {
      throw new GoneException(REJECTED_CERTIFICATION_FILE_DELETED);
    }
    const { url, expiresAt } = await this.storage.presignGet(row.file_key);
    await this.audit.record({
      action: AUDIT_ACTIONS.certificationUploadView,
      actor: { ...actor, role: 'admin' },
      targetType: 'certification_upload',
      targetId: id,
      metadata: { instructorId: row.instructor_id },
    });
    return { url, expiresAt, sha256: row.sha256 };
  }

  /**
   * Sets the review outcome (and optionally the note and a corrected
   * `validUntil`), stamping `reviewed_by`/`reviewed_at`. Changing `validUntil`
   * clears `expiry_reminder_sent_at` so the expiry emails follow the new date.
   * Rejecting deletes the file (best effort, audited) and emails the
   * instructor; a rejected upload cannot move to another status (409).
   */
  async review(
    id: string,
    dto: ReviewCertificationUploadDto,
    actor: AuditActor,
    now = new Date(),
  ): Promise<CertUpload> {
    const before = await this.load(id);
    const wasRejected = before.review_status === 'rejected';
    if (wasRejected && dto.reviewStatus !== 'rejected') {
      throw new ConflictException(REJECTED_CERTIFICATION_FINAL);
    }
    const patch: CertificationUploadWrite = {
      review_status: dto.reviewStatus,
      reviewed_by: actor.userId ?? null,
      reviewed_at: now.toISOString(),
    };
    if (dto.reviewStatus === 'approved') {
      patch.verified_level = await this.declaredLevel(before);
    } else if (dto.reviewStatus === 'rejected') {
      patch.verified_level = null;
    }
    const fields: ReviewedField[] = ['review_status'];
    if (dto.reviewNote !== undefined) {
      patch.review_note = dto.reviewNote || null;
      fields.push('review_note');
    }
    if (dto.validUntil !== undefined) {
      fields.push('valid_until');
      if (dto.validUntil !== before.valid_until) {
        patch.valid_until = dto.validUntil;
        patch.expiry_reminder_sent_at = null;
      }
    }
    const row = await this.uploads.update(
      id,
      patch,
      dto.reviewStatus === 'rejected' ? undefined : ['pending', 'approved'],
    );
    if (!row) {
      const current = await this.uploads.findById(id);
      if (current?.review_status === 'rejected') {
        throw new ConflictException(REJECTED_CERTIFICATION_FINAL);
      }
      throw new NotFoundException(CERTIFICATION_UPLOAD_NOT_FOUND);
    }
    await this.audit.record({
      action: AUDIT_ACTIONS.certificationUploadReview,
      actor: { ...actor, role: 'admin' },
      targetType: 'certification_upload',
      targetId: id,
      metadata: {
        instructorId: row.instructor_id,
        org: row.org,
        track: row.track,
        before: pick(before, fields),
        after: pick(row, fields),
      },
    });
    if (row.review_status === 'rejected') {
      await this.deleteFile(row, actor);
      if (!wasRejected) {
        await this.emailRejection(row);
      }
    }
    const rows = await this.subjects.listCertificationUploads(
      row.instructor_id,
    );
    const upload = toCertUploads(rows, torontoToday(now)).find(
      (u) => u.id === id,
    );
    if (!upload) {
      throw new NotFoundException(CERTIFICATION_UPLOAD_NOT_FOUND);
    }
    return upload;
  }

  private async deleteFile(
    row: CertificationUploadRow,
    actor: AuditActor,
  ): Promise<void> {
    let deleted = true;
    try {
      await this.storage.delete(row.file_key);
    } catch (err) {
      deleted = false;
      this.logger.warn(
        `Failed to delete rejected certification file ${row.file_key}: ${(err as Error).message}`,
      );
    }
    await this.audit.record({
      action: AUDIT_ACTIONS.certificationUploadFileDelete,
      actor: { ...actor, role: 'admin' },
      targetType: 'certification_upload',
      targetId: row.id,
      metadata: {
        instructorId: row.instructor_id,
        fileKey: row.file_key,
        deleted,
      },
    });
  }

  private async emailRejection(row: CertificationUploadRow): Promise<void> {
    let instructor: DocumentInstructorRow | null;
    let certifications: InstructorCertificationRow[];
    try {
      [instructor, certifications] = await Promise.all([
        this.subjects.findInstructor(row.instructor_id),
        this.subjects.listCertifications(row.instructor_id),
      ]);
    } catch (err) {
      this.logger.warn(
        `Failed to load the instructor for certification rejection email ${row.id}: ${(err as Error).message}`,
      );
      return;
    }
    if (!instructor) {
      return;
    }
    const level = certifications.find(
      (c) => c.org === row.org && c.track === row.track,
    )?.level;
    const language = resolveEmailLanguage(instructor.preferred_language);
    void this.mailer.send({
      template: 'certification.rejected',
      to: instructor.email,
      language,
      vars: {
        displayName: instructor.display_name_en || undefined,
        org: row.org,
        track: row.track,
        level: level ?? null,
        reason: row.review_note,
        uploadUrl: withPortalLanguage(
          this.mailer.portalLink(CERTIFICATION_REUPLOAD_PATH),
          language,
        ),
      },
      mode: 'background',
      instructorId: instructor.id,
      authUserId: instructor.auth_user_id,
      metadata: {
        certificationUploadId: row.id,
        certification: certificationKey(row.org, row.track),
      },
      idempotencyKey: `certification.rejected:${row.id}`,
    });
  }

  private async declaredLevel(
    row: CertificationUploadRow,
  ): Promise<number | null> {
    const certifications = await this.subjects.listCertifications(
      row.instructor_id,
    );
    return (
      certifications.find((c) => c.org === row.org && c.track === row.track)
        ?.level ?? null
    );
  }

  private async load(id: string): Promise<CertificationUploadRow> {
    const row = await this.uploads.findById(id);
    if (!row) {
      throw new NotFoundException(CERTIFICATION_UPLOAD_NOT_FOUND);
    }
    return row;
  }
}
