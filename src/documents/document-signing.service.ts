import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { legalNameOf } from '../instructors/legal-name';
import {
  type DocumentAssignmentWrite,
  DocumentAssignmentsRepository,
} from './document-assignments.repository';
import { torontoToday } from './certification-validity';
import { ASSIGNMENT_NOT_FOUND } from './document-assignments.service';
import {
  DocumentCompletedHandler,
  type SignedDocument,
} from './document-completed.handler';
import { DocumentTemplatesRepository } from './document-templates.repository';
import { TEMPLATE_NOT_FOUND } from './document-templates.service';
import type {
  CompletedDocument,
  DocumentAssignmentRow,
  DocumentInstructorRow,
  DocumentLanguage,
  DocumentTemplateRow,
  SignedUrl,
  SigningDocument,
} from './documents.types';
import { toAssignment, toSigningTemplate } from './documents.presenters';
import type { CompleteDocumentDto } from './dto/complete-document.dto';
import { MeDocumentsService } from './me-documents.service';
import { stampDocument } from './pdf-stamper';
import { PdfWorkQueue } from './pdf-work-queue';
import {
  ObjectTooLargeError,
  PrivateStorageClient,
} from './private-storage.client';
import {
  parseSigningInput,
  type SigningInput,
  SigningInputError,
} from './signing-input';
import { storageKeys } from './storage-keys';
import {
  MAX_TEMPLATE_BYTES,
  PDF_CONTENT_TYPE,
  sha256Hex,
} from './template-pdf';
import {
  mainVersion,
  signerLanguages,
  signerVersion,
  type TemplateVersion,
} from './template-versions';

export const ALREADY_COMPLETED = 'This document has already been completed';
export const VERSION_HAS_NO_FIELDS =
  'This version of the document has no fields to sign yet';
export const ACKNOWLEDGEMENT_REQUIRED =
  'Tick "I have read and understood" to complete this document';
export const CONSENT_REQUIRED =
  'Agree to sign electronically to complete this document';
export const NO_SIGNED_COPY = 'This document has no signed copy';
export const TEMPLATE_PDF_UNAVAILABLE =
  'The document PDF is not available; ask an admin to upload it again';
export const LANGUAGE_UNAVAILABLE =
  'This document is not available in that language';

/** Fixed consent wording: returned to the signer by `open` and printed on the audit page. */
export const SIGNING_CONSENT = {
  en: 'I agree to sign this document electronically. My electronic signature has the same effect as my handwritten signature.',
  zh: '我同意以电子方式签署本文件。我的电子签名与手写签名具有同等效力。',
} as const;

const OPEN_STATUSES: DocumentAssignmentRow['status'][] = ['assigned', 'viewed'];
const USER_AGENT_MAX_LENGTH = 512;
const FILENAME_UNSAFE = /[\\/:*?"<>|\p{Cc}]+/gu;

/** Request facts recorded as signing evidence. */
export interface SigningEvidence {
  ip: string | null;
  userAgent: string | null;
}

function signedFilename(row: DocumentAssignmentRow): string {
  const title = (row.template?.title_en ?? 'document')
    .replace(FILENAME_UNSAFE, ' ')
    .trim();
  return `${title || 'document'}.pdf`;
}

/**
 * Opening, completing and downloading assigned documents. Completing a `sign`
 * document stamps the template inside {@link PdfWorkQueue}, stores the signed
 * copy, records the evidence, then calls the optional
 * {@link DocumentCompletedHandler}.
 */
@Injectable()
export class DocumentSigningService {
  private readonly logger = new Logger(DocumentSigningService.name);

  constructor(
    private readonly me: MeDocumentsService,
    private readonly assignments: DocumentAssignmentsRepository,
    private readonly templates: DocumentTemplatesRepository,
    private readonly storage: PrivateStorageClient,
    private readonly pdfQueue: PdfWorkQueue,
    @Optional() private readonly completedHandler?: DocumentCompletedHandler,
  ) {}

  /** `GET /me/documents/:assignmentId`: the template to render; marks the assignment viewed. */
  async open(
    authUserId: string,
    assignmentId: string,
    language?: DocumentLanguage,
    now = new Date(),
  ): Promise<SigningDocument> {
    const instructor = await this.me.approvedInstructorFor(authUserId);
    let row = await this.ownedOpenable(instructor, assignmentId);
    const template = await this.loadTemplate(row.template_id);
    const version =
      (language && signerVersion(template, language)) || mainVersion(template);
    if (row.status === 'assigned') {
      row =
        (await this.assignments.updateIfStatus(row.id, ['assigned'], {
          status: 'viewed',
          viewed_at: now.toISOString(),
        })) ??
        (await this.assignments.findById(row.id)) ??
        row;
    }
    const sourceUrl = version.source_key
      ? (await this.storage.presignGet(version.source_key)).url
      : null;
    return {
      assignment: toAssignment(row),
      template: toSigningTemplate(template, version),
      sourceUrl,
      language: version.language,
      availableLanguages: signerLanguages(template),
      consentText: { en: SIGNING_CONSENT.en, zh: SIGNING_CONSENT.zh },
    };
  }

  /** `POST /me/documents/:assignmentId/complete` for both `read` and `sign` documents. */
  async complete(
    authUserId: string,
    assignmentId: string,
    dto: CompleteDocumentDto,
    evidence: SigningEvidence,
    now = new Date(),
  ): Promise<CompletedDocument> {
    const instructor = await this.me.approvedInstructorFor(authUserId);
    const row = await this.ownedOpenable(instructor, assignmentId);
    if (row.status === 'completed') {
      throw new ConflictException(ALREADY_COMPLETED);
    }
    const template = await this.loadTemplate(row.template_id);
    const version = this.signingVersion(template, dto.language);
    const signer = {
      viewed_at: row.viewed_at ?? now.toISOString(),
      consent_at: now.toISOString(),
      completed_at: now.toISOString(),
      signer_email: instructor.email,
      signer_ip: evidence.ip,
      signer_user_agent:
        evidence.userAgent?.slice(0, USER_AGENT_MAX_LENGTH) ?? null,
    };
    if (template.kind === 'read') {
      if (dto.acknowledged !== true) {
        throw new BadRequestException(ACKNOWLEDGEMENT_REQUIRED);
      }
      const updated = await this.markCompleted(row.id, {
        ...signer,
        signer_name: legalNameOf(instructor),
        template_sha256: version.source_sha256,
        language: version.language,
      });
      return { assignment: toAssignment(updated) };
    }
    if (dto.consent !== true) {
      throw new BadRequestException(CONSENT_REQUIRED);
    }
    if (version.fields.length === 0) {
      throw new BadRequestException(VERSION_HAS_NO_FIELDS);
    }
    const input = this.parseInput(version, dto, instructor, now);
    const signed = await this.signAndStore(
      instructor,
      row,
      template,
      version,
      input,
      evidence,
      signer,
    );
    const updated = signed.assignment;
    await this.notifyCompleted(signed);
    const { url } = await this.storage.presignGet(updated.signed_key!, {
      filename: signedFilename(updated),
    });
    return { assignment: toAssignment(updated), signedUrl: url };
  }

  /** `GET /me/documents/:assignmentId/signed-url`: the caller's own signed copy. */
  async instructorSignedUrl(
    authUserId: string,
    assignmentId: string,
  ): Promise<SignedUrl> {
    const instructor = await this.me.instructorFor(authUserId);
    return this.signedUrlFor(await this.owned(instructor, assignmentId));
  }

  /** `GET /admin/documents/assignments/:id/signed-url`. */
  async adminSignedUrl(assignmentId: string): Promise<SignedUrl> {
    const row = await this.assignments.findById(assignmentId);
    if (!row) {
      throw new NotFoundException(ASSIGNMENT_NOT_FOUND);
    }
    return this.signedUrlFor(row);
  }

  private async signedUrlFor(row: DocumentAssignmentRow): Promise<SignedUrl> {
    if (!row.signed_key) {
      throw new NotFoundException(NO_SIGNED_COPY);
    }
    const { url, expiresAt } = await this.storage.presignGet(row.signed_key, {
      filename: signedFilename(row),
    });
    return { url, expiresAt, sha256: row.signed_sha256 };
  }

  private signingVersion(
    template: DocumentTemplateRow,
    language: DocumentLanguage | null | undefined,
  ): TemplateVersion {
    if (!language) {
      return mainVersion(template);
    }
    const version = signerVersion(template, language);
    if (!version) {
      throw new BadRequestException(LANGUAGE_UNAVAILABLE);
    }
    return version;
  }

  private parseInput(
    version: TemplateVersion,
    dto: CompleteDocumentDto,
    instructor: DocumentInstructorRow,
    now: Date,
  ): SigningInput {
    try {
      return parseSigningInput(version.fields, dto, {
        email: instructor.email,
        dateSigned: torontoToday(now),
      });
    } catch (err) {
      if (err instanceof SigningInputError) {
        throw new BadRequestException(err.message);
      }
      throw err;
    }
  }

  private signAndStore(
    instructor: DocumentInstructorRow,
    row: DocumentAssignmentRow,
    template: DocumentTemplateRow,
    version: TemplateVersion,
    input: SigningInput,
    evidence: SigningEvidence,
    signer: DocumentAssignmentWrite & {
      viewed_at: string;
      completed_at: string;
    },
  ): Promise<SignedDocument> {
    const sourceKey = version.source_key;
    if (!sourceKey) {
      throw new BadRequestException(TEMPLATE_PDF_UNAVAILABLE);
    }
    return this.pdfQueue.run(async () => {
      const current = await this.assignments.findById(row.id);
      if (!current || !OPEN_STATUSES.includes(current.status)) {
        throw new ConflictException(ALREADY_COMPLETED);
      }
      const source = await this.readSource(sourceKey);
      const templateSha256 = sha256Hex(source);
      if (version.source_sha256 && version.source_sha256 !== templateSha256) {
        this.logger.warn(
          `Template ${template.id} source hash ${templateSha256} differs from the recorded ${version.source_sha256}`,
        );
      }
      const stamped = await stampDocument({
        source,
        fields: version.fields,
        values: input.values,
        signatures: input.signatures,
        audit: {
          titleEn: template.title_en,
          titleZh: template.title_zh,
          templateSha256,
          assignmentId: row.id,
          signerName: input.signerName,
          signerEmail: instructor.email,
          consentEn: SIGNING_CONSENT.en,
          consentZh: SIGNING_CONSENT.zh,
          ip: evidence.ip,
          userAgent: evidence.userAgent,
          viewedAt: signer.viewed_at,
          signedAt: signer.completed_at,
          language: version.language,
        },
      });
      const key = storageKeys.instructorDocument(instructor.id, row.id);
      await this.storage.put(key, stamped.bytes, PDF_CONTENT_TYPE);
      const assignment = await this.markCompleted(row.id, {
        ...signer,
        signer_name: input.signerName,
        template_sha256: templateSha256,
        language: version.language,
        signed_key: key,
        signed_sha256: stamped.sha256,
        field_values: input.fieldValues,
      });
      return {
        assignment,
        template,
        pdf: Buffer.from(
          stamped.bytes.buffer,
          stamped.bytes.byteOffset,
          stamped.bytes.byteLength,
        ),
        sha256: stamped.sha256,
      };
    });
  }

  private async readSource(key: string): Promise<Uint8Array> {
    try {
      const source = await this.storage.getBuffer(key, MAX_TEMPLATE_BYTES);
      if (source) {
        return source;
      }
    } catch (err) {
      if (!(err instanceof ObjectTooLargeError)) {
        throw err;
      }
    }
    throw new BadRequestException(TEMPLATE_PDF_UNAVAILABLE);
  }

  private async markCompleted(
    id: string,
    patch: DocumentAssignmentWrite,
  ): Promise<DocumentAssignmentRow> {
    const updated = await this.assignments.updateIfStatus(id, OPEN_STATUSES, {
      ...patch,
      status: 'completed',
    });
    if (!updated) {
      throw new ConflictException(ALREADY_COMPLETED);
    }
    return updated;
  }

  private async notifyCompleted(document: SignedDocument): Promise<void> {
    if (!this.completedHandler) {
      return;
    }
    try {
      await this.completedHandler.documentCompleted(document);
    } catch (err) {
      this.logger.error(
        `Completed-document handler failed for assignment ${document.assignment.id}: ${(err as Error).message}`,
      );
    }
  }

  private async owned(
    instructor: DocumentInstructorRow,
    assignmentId: string,
  ): Promise<DocumentAssignmentRow> {
    const row = await this.assignments.findById(assignmentId);
    if (
      !row ||
      row.subject_type !== 'instructor' ||
      row.subject_id !== instructor.id
    ) {
      throw new NotFoundException(ASSIGNMENT_NOT_FOUND);
    }
    return row;
  }

  private async ownedOpenable(
    instructor: DocumentInstructorRow,
    assignmentId: string,
  ): Promise<DocumentAssignmentRow> {
    const row = await this.owned(instructor, assignmentId);
    if (row.status === 'archived') {
      throw new NotFoundException(ASSIGNMENT_NOT_FOUND);
    }
    return row;
  }

  private async loadTemplate(id: string): Promise<DocumentTemplateRow> {
    const template = await this.templates.findById(id);
    if (!template) {
      throw new NotFoundException(TEMPLATE_NOT_FOUND);
    }
    return template;
  }
}
