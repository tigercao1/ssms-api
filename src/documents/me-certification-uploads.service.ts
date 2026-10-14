import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  CERTIFICATION_FILE_EXTENSIONS,
  type CertificationContentType,
  isCertificationContentType,
  MAX_CERTIFICATION_BYTES,
  matchesSignature,
  mediaType,
} from './certification-files';
import { hasCode, PG_UNIQUE_VIOLATION } from '../database/db-result';
import {
  CertificationUploadsRepository,
  type NewCertificationUploadRow,
} from './certification-uploads.repository';
import { daysBetween, torontoToday } from './certification-validity';
import { DocumentSubjectsRepository } from './document-subjects.repository';
import {
  CERT_ORGS,
  CERT_TRACKS,
  type CertOrg,
  type CertTrack,
  type CertUpload,
  type CertificationUploadUrl,
  type DocumentInstructorRow,
} from './documents.types';
import { toCertUploads } from './documents.presenters';
import type { CertificationUploadUrlDto } from './dto/certification-upload.dto';
import { MeDocumentsService } from './me-documents.service';
import {
  ObjectTooLargeError,
  PrivateStorageClient,
} from './private-storage.client';
import { storageKeys } from './storage-keys';
import { sha256Hex } from './template-pdf';

export const VALID_UNTIL_IN_PAST = 'validUntil must be today or later';
export const NO_MATCHING_CERTIFICATION =
  'Add this certification to your profile before uploading proof of it';
export const CERTIFICATION_UPLOAD_NOT_FOUND = 'Certification upload not found';
export const CERTIFICATION_FILE_MISSING =
  'No uploaded file found; upload the file to the upload URL first';
export const CERTIFICATION_FILE_TOO_LARGE = `The file is larger than ${MAX_CERTIFICATION_BYTES / 1024 / 1024} MB`;
export const CERTIFICATION_FILE_MISMATCH =
  'The uploaded file does not match the declared type and size';

const INTENT_MAX_BYTES = 4096;

/** What the instructor declared at presign time, stored next to the upload until confirm. */
export interface CertificationUploadIntent {
  uploadId: string;
  instructorId: string;
  org: CertOrg;
  track: CertTrack;
  validUntil: string;
  contentType: CertificationContentType;
  contentLength: number;
}

function parseIntent(
  bytes: Buffer,
  uploadId: string,
  instructorId: string,
): CertificationUploadIntent | null {
  let value: Partial<CertificationUploadIntent>;
  try {
    value = JSON.parse(bytes.toString('utf8')) as typeof value;
  } catch {
    return null;
  }
  const valid =
    value.uploadId === uploadId &&
    value.instructorId === instructorId &&
    CERT_ORGS.includes(value.org as CertOrg) &&
    CERT_TRACKS.includes(value.track as CertTrack) &&
    typeof value.validUntil === 'string' &&
    isCertificationContentType(value.contentType) &&
    Number.isInteger(value.contentLength);
  return valid ? (value as CertificationUploadIntent) : null;
}

/**
 * The instructor's own certification proof uploads
 * (`/me/certification-uploads`). The upload id is issued with the presigned
 * URL; the row is inserted only on confirm, once the file is checked and hashed.
 */
@Injectable()
export class MeCertificationUploadsService {
  private readonly logger = new Logger(MeCertificationUploadsService.name);

  constructor(
    private readonly me: MeDocumentsService,
    private readonly subjects: DocumentSubjectsRepository,
    private readonly uploads: CertificationUploadsRepository,
    private readonly storage: PrivateStorageClient,
  ) {}

  /** Issues an upload id and a presigned PUT to a staging key under the caller's certification prefix. */
  async uploadUrl(
    authUserId: string,
    dto: CertificationUploadUrlDto,
    today = torontoToday(),
  ): Promise<CertificationUploadUrl> {
    const instructor = await this.me.instructorFor(authUserId);
    if (daysBetween(today, dto.validUntil) < 0) {
      throw new BadRequestException(VALID_UNTIL_IN_PAST);
    }
    const certifications = await this.subjects.listCertifications(
      instructor.id,
    );
    if (
      !certifications.some((c) => c.org === dto.org && c.track === dto.track)
    ) {
      throw new BadRequestException(NO_MATCHING_CERTIFICATION);
    }
    const intent: CertificationUploadIntent = {
      uploadId: randomUUID(),
      instructorId: instructor.id,
      org: dto.org,
      track: dto.track,
      validUntil: dto.validUntil,
      contentType: dto.contentType,
      contentLength: dto.contentLength,
    };
    await this.storage.put(
      storageKeys.instructorCertificationIntent(instructor.id, intent.uploadId),
      Buffer.from(JSON.stringify(intent)),
      'application/json',
    );
    const { url, expiresAt } = await this.storage.presignPut(
      this.stagingKey(intent),
      { contentType: dto.contentType, contentLength: dto.contentLength },
    );
    return { uploadId: intent.uploadId, uploadUrl: url, expiresAt };
  }

  /**
   * Checks the staged file (HEAD size and type, then one capped read that is
   * hashed and checked for its leading bytes), writes those bytes to a final
   * key that is never presigned for upload, and records the upload. Only the
   * caller's own upload ids resolve; confirming twice returns the same upload.
   */
  async confirm(
    authUserId: string,
    uploadId: string,
    today = torontoToday(),
  ): Promise<CertUpload> {
    const instructor = await this.me.instructorFor(authUserId);
    const existing = await this.uploads.findById(uploadId);
    if (existing) {
      if (existing.instructor_id !== instructor.id) {
        throw new NotFoundException(CERTIFICATION_UPLOAD_NOT_FOUND);
      }
      return this.present(instructor, uploadId, today);
    }
    const intentKey = storageKeys.instructorCertificationIntent(
      instructor.id,
      uploadId,
    );
    const intentBytes = await this.storage.getBuffer(
      intentKey,
      INTENT_MAX_BYTES,
    );
    const intent = intentBytes
      ? parseIntent(intentBytes, uploadId, instructor.id)
      : null;
    if (!intent) {
      throw new NotFoundException(CERTIFICATION_UPLOAD_NOT_FOUND);
    }
    const stagingKey = this.stagingKey(intent);
    const bytes = await this.readStaged(intent, stagingKey, intentKey);
    const sha256 = sha256Hex(bytes);
    const fileKey = storageKeys.instructorCertification(
      intent.instructorId,
      intent.uploadId,
      sha256,
      CERTIFICATION_FILE_EXTENSIONS[intent.contentType],
    );
    await this.storage.put(fileKey, bytes, intent.contentType);
    const inserted = await this.insertOnce({
      id: uploadId,
      instructor_id: instructor.id,
      org: intent.org,
      track: intent.track,
      file_key: fileKey,
      sha256,
      content_type: intent.contentType,
      size_bytes: bytes.length,
      valid_until: intent.validUntil,
    });
    if (!inserted) {
      const winner = await this.uploads.findById(uploadId);
      if (winner?.file_key !== fileKey) {
        await this.discard(fileKey);
      }
    }
    await this.discard(stagingKey, intentKey);
    return this.present(instructor, uploadId, today);
  }

  private async readStaged(
    intent: CertificationUploadIntent,
    stagingKey: string,
    intentKey: string,
  ): Promise<Buffer> {
    const head = await this.storage.head(stagingKey);
    if (!head) {
      throw new BadRequestException(CERTIFICATION_FILE_MISSING);
    }
    if (head.contentLength > MAX_CERTIFICATION_BYTES) {
      await this.discard(stagingKey, intentKey);
      throw new BadRequestException(CERTIFICATION_FILE_TOO_LARGE);
    }
    if (
      head.contentLength !== intent.contentLength ||
      mediaType(head.contentType) !== intent.contentType
    ) {
      await this.discard(stagingKey, intentKey);
      throw new BadRequestException(CERTIFICATION_FILE_MISMATCH);
    }
    let bytes: Buffer | null;
    try {
      bytes = await this.storage.getBuffer(stagingKey, MAX_CERTIFICATION_BYTES);
    } catch (err) {
      if (err instanceof ObjectTooLargeError) {
        await this.discard(stagingKey, intentKey);
        throw new BadRequestException(CERTIFICATION_FILE_TOO_LARGE);
      }
      throw err;
    }
    if (!bytes) {
      throw new BadRequestException(CERTIFICATION_FILE_MISSING);
    }
    if (
      bytes.length !== intent.contentLength ||
      !matchesSignature(intent.contentType, bytes)
    ) {
      await this.discard(stagingKey, intentKey);
      throw new BadRequestException(CERTIFICATION_FILE_MISMATCH);
    }
    return bytes;
  }

  private async insertOnce(row: NewCertificationUploadRow): Promise<boolean> {
    try {
      await this.uploads.insert(row);
      return true;
    } catch (err) {
      if (!hasCode(err, PG_UNIQUE_VIOLATION)) {
        throw err;
      }
      return false;
    }
  }

  private stagingKey(intent: CertificationUploadIntent): string {
    return storageKeys.instructorCertificationStaging(
      intent.instructorId,
      intent.uploadId,
      CERTIFICATION_FILE_EXTENSIONS[intent.contentType],
    );
  }

  private async present(
    instructor: DocumentInstructorRow,
    uploadId: string,
    today: string,
  ): Promise<CertUpload> {
    const rows = await this.subjects.listCertificationUploads(instructor.id);
    const upload = toCertUploads(rows, today).find((u) => u.id === uploadId);
    if (!upload) {
      throw new NotFoundException(CERTIFICATION_UPLOAD_NOT_FOUND);
    }
    return upload;
  }

  private async discard(...keys: string[]): Promise<void> {
    for (const key of keys) {
      try {
        await this.storage.delete(key);
      } catch (err) {
        this.logger.warn(
          `Failed to delete certification object ${key}: ${(err as Error).message}`,
        );
      }
    }
  }
}
