import { Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { AUDIT_ACTIONS, type AuditActor } from '../audit/audit.types';
import {
  CertificationUploadsRepository,
  type CertificationUploadWrite,
} from './certification-uploads.repository';
import { torontoToday } from './certification-validity';
import { DocumentSubjectsRepository } from './document-subjects.repository';
import type {
  CertUpload,
  CertificationFileUrl,
  CertificationUploadRow,
} from './documents.types';
import { toCertUploads } from './documents.presenters';
import type { ReviewCertificationUploadDto } from './dto/certification-upload.dto';
import { CERTIFICATION_UPLOAD_NOT_FOUND } from './me-certification-uploads.service';
import { PrivateStorageClient } from './private-storage.client';

type ReviewedField = 'review_status' | 'review_note' | 'valid_until';

function pick(row: CertificationUploadRow, fields: ReviewedField[]) {
  return Object.fromEntries(fields.map((f) => [f, row[f]]));
}

/** Admin review of certification uploads: view the file, approve/reject, correct `validUntil`. */
@Injectable()
export class AdminCertificationUploadsService {
  constructor(
    private readonly uploads: CertificationUploadsRepository,
    private readonly subjects: DocumentSubjectsRepository,
    private readonly storage: PrivateStorageClient,
    private readonly audit: AuditService,
  ) {}

  /** Presigned GET of the uploaded file (served inline). Audited. */
  async fileUrl(id: string, actor: AuditActor): Promise<CertificationFileUrl> {
    const row = await this.load(id);
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
   */
  async review(
    id: string,
    dto: ReviewCertificationUploadDto,
    actor: AuditActor,
    now = new Date(),
  ): Promise<CertUpload> {
    const before = await this.load(id);
    const patch: CertificationUploadWrite = {
      review_status: dto.reviewStatus,
      reviewed_by: actor.userId ?? null,
      reviewed_at: now.toISOString(),
    };
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
    const row = await this.uploads.update(id, patch);
    if (!row) {
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

  private async load(id: string): Promise<CertificationUploadRow> {
    const row = await this.uploads.findById(id);
    if (!row) {
      throw new NotFoundException(CERTIFICATION_UPLOAD_NOT_FOUND);
    }
    return row;
  }
}
