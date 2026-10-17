import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { AUDIT_ACTIONS, type AuditActor } from '../audit/audit.types';
import { DocumentAssignmentsRepository } from './document-assignments.repository';
import { DocumentSubjectsRepository } from './document-subjects.repository';
import { DocumentTemplatesRepository } from './document-templates.repository';
import type {
  ConfirmedTemplate,
  DocumentLanguage,
  DocumentTemplateRow,
  DocumentTemplateWrite,
  Template,
  TemplateCounts,
  TemplateField,
  TemplateSummary,
  UploadUrl,
} from './documents.types';
import {
  NO_TEMPLATE_COUNTS,
  toTemplate,
  toTemplateFieldRow,
  toTemplateSummary,
} from './documents.presenters';
import type { CreateTemplateDto, UpdateTemplateDto } from './dto/template.dto';
import { PdfWorkQueue } from './pdf-work-queue';
import {
  ObjectTooLargeError,
  PrivateStorageClient,
} from './private-storage.client';
import { storageKeys } from './storage-keys';
import { TemplateFieldError, validateTemplateFields } from './template-fields';
import {
  MAX_TEMPLATE_BYTES,
  type NormalisedTemplatePdf,
  normaliseTemplatePdf,
  PDF_CONTENT_TYPE,
  samePageLayout,
  TemplatePdfError,
} from './template-pdf';
import { findTranslation } from './template-versions';

export const TEMPLATE_NOT_FOUND = 'Document template not found';
export const NOTHING_TO_UPDATE = 'Nothing to update';
export const SOURCE_UPLOAD_MISSING =
  'No uploaded PDF found; request an upload URL and upload the file first';
export const SOURCE_TOO_LARGE = `The PDF is larger than ${MAX_TEMPLATE_BYTES / 1024 / 1024} MB`;
export const SOURCE_NOT_PDF =
  'The uploaded file must be sent as application/pdf';
export const TEMPLATE_HAS_NO_SOURCE =
  'Upload the template PDF before placing fields';
export const TEMPLATE_LOCKED =
  'Someone has completed this document, so its PDF and fields can no longer change. Retire it and publish a new one instead.';
export const TRANSLATION_NEEDS_SOURCE_LANGUAGE =
  'Set the language of the main PDF before adding another language version';
export const TRANSLATION_SAME_AS_SOURCE =
  'The other language version must be in a different language from the main PDF';
export const TRANSLATION_NOT_FOUND =
  'This document has no version in that language';
export const SOURCE_LANGUAGE_CONFLICT =
  'Remove the other language version before changing the language of the main PDF to it or clearing it';

const UPDATE_FIELDS: [keyof UpdateTemplateDto, keyof DocumentTemplateWrite][] =
  [
    ['titleEn', 'title_en'],
    ['titleZh', 'title_zh'],
    ['descriptionEn', 'description_en'],
    ['descriptionZh', 'description_zh'],
    ['required', 'required'],
    ['sortOrder', 'sort_order'],
    ['sourceLanguage', 'source_language'],
  ];
const NULLABLE_TEXT = new Set<keyof UpdateTemplateDto>([
  'titleZh',
  'descriptionEn',
  'descriptionZh',
]);

function toWrite(dto: UpdateTemplateDto): DocumentTemplateWrite {
  const write: Record<string, unknown> = {};
  for (const [from, to] of UPDATE_FIELDS) {
    if (dto[from] !== undefined) {
      write[to] = NULLABLE_TEXT.has(from) ? dto[from] || null : dto[from];
    }
  }
  return write;
}

function validateFields(
  fields: TemplateField[],
  pages: DocumentTemplateRow['pages'],
): void {
  try {
    validateTemplateFields(fields, pages);
  } catch (err) {
    if (err instanceof TemplateFieldError) {
      throw new BadRequestException(err.message);
    }
    throw err;
  }
}

function isPdfContentType(contentType: string | null): boolean {
  return (
    (contentType ?? '').split(';')[0].trim().toLowerCase() === PDF_CONTENT_TYPE
  );
}

/**
 * Admin management of document templates: metadata CRUD, the source PDF
 * (presigned upload, then validate + normalise on confirm) and placed fields.
 * The PDF and fields are locked (409) once any assignment is completed.
 */
@Injectable()
export class DocumentTemplatesService {
  private readonly logger = new Logger(DocumentTemplatesService.name);

  constructor(
    private readonly repo: DocumentTemplatesRepository,
    private readonly assignments: DocumentAssignmentsRepository,
    private readonly subjects: DocumentSubjectsRepository,
    private readonly storage: PrivateStorageClient,
    private readonly pdfQueue: PdfWorkQueue,
    private readonly audit: AuditService,
  ) {}

  async list(): Promise<TemplateSummary[]> {
    const rows = await this.repo.list();
    const counts = await this.counts(rows);
    return rows.map((row, i) => toTemplateSummary(row, counts[i]));
  }

  /** Template with a presigned `sourceUrl` (null before a source is confirmed). */
  async get(id: string): Promise<Template> {
    return this.present(await this.load(id));
  }

  /** Loads a template row or throws 404. */
  async load(id: string): Promise<DocumentTemplateRow> {
    const row = await this.repo.findById(id);
    if (!row) {
      throw new NotFoundException(TEMPLATE_NOT_FOUND);
    }
    return row;
  }

  async create(dto: CreateTemplateDto, actor: AuditActor): Promise<Template> {
    const row = await this.repo.insert({
      ...toWrite(dto),
      kind: dto.kind,
      audience: dto.audience,
      title_en: dto.titleEn,
      status: 'draft',
      updated_by: actor.userId ?? null,
    });
    await this.audit.record({
      action: AUDIT_ACTIONS.documentTemplateCreate,
      actor: { ...actor, role: 'admin' },
      targetType: 'document_template',
      targetId: row.id,
      metadata: { after: toTemplateSummary(row, NO_TEMPLATE_COUNTS) },
    });
    return toTemplate(row, null, NO_TEMPLATE_COUNTS);
  }

  async update(
    id: string,
    dto: UpdateTemplateDto,
    actor: AuditActor,
  ): Promise<Template> {
    const patch = toWrite(dto);
    const fields = Object.keys(patch) as (keyof DocumentTemplateWrite)[];
    if (fields.length === 0) {
      throw new BadRequestException(NOTHING_TO_UPDATE);
    }
    const before = await this.load(id);
    if (
      patch.source_language !== undefined &&
      before.translations.some(
        (t) =>
          patch.source_language === null ||
          t.language === patch.source_language,
      )
    ) {
      throw new BadRequestException(SOURCE_LANGUAGE_CONFLICT);
    }
    const row = await this.repo.update(id, {
      ...patch,
      updated_by: actor.userId ?? null,
    });
    if (!row) {
      throw new NotFoundException(TEMPLATE_NOT_FOUND);
    }
    await this.audit.record({
      action: AUDIT_ACTIONS.documentTemplateUpdate,
      actor: { ...actor, role: 'admin' },
      targetType: 'document_template',
      targetId: id,
      metadata: {
        before: Object.fromEntries(fields.map((f) => [f, before[f]])),
        after: Object.fromEntries(fields.map((f) => [f, row[f]])),
      },
    });
    return this.present(row);
  }

  /** Presigned PUT for a replacement source PDF (validated on confirm). */
  async sourceUploadUrl(id: string, contentLength: number): Promise<UploadUrl> {
    await this.loadEditable(id);
    const { url, expiresAt } = await this.storage.presignPut(
      storageKeys.templateUpload(id),
      { contentType: PDF_CONTENT_TYPE, contentLength },
    );
    return { uploadUrl: url, expiresAt };
  }

  /**
   * Validates the uploaded PDF, stores the normalised copy as the template
   * source and records its pages, page count and SHA-256. Placed fields are
   * kept only when the page layout is unchanged.
   */
  async confirmSource(
    id: string,
    actor: AuditActor,
  ): Promise<ConfirmedTemplate> {
    const before = await this.loadEditable(id);
    const uploadKey = storageKeys.templateUpload(id);
    const normalised = await this.normaliseUpload(uploadKey);
    const sourceKey = storageKeys.templateSource(id);
    await this.storage.put(sourceKey, normalised.bytes, PDF_CONTENT_TYPE);
    const fieldsCleared =
      before.fields.length > 0 &&
      !samePageLayout(before.pages, normalised.pages);
    const row = await this.repo.update(id, {
      source_key: sourceKey,
      source_sha256: normalised.sha256,
      page_count: normalised.pageCount,
      pages: normalised.pages,
      ...(fieldsCleared ? { fields: [] } : {}),
      updated_by: actor.userId ?? null,
    });
    if (!row) {
      throw new NotFoundException(TEMPLATE_NOT_FOUND);
    }
    await this.discardUpload(uploadKey);
    await this.audit.record({
      action: AUDIT_ACTIONS.documentTemplateSourceReplace,
      actor: { ...actor, role: 'admin' },
      targetType: 'document_template',
      targetId: id,
      metadata: {
        beforeSha256: before.source_sha256,
        afterSha256: normalised.sha256,
        pageCount: normalised.pageCount,
        sizeBytes: normalised.bytes.byteLength,
        fieldsCleared,
        clearedFieldCount: fieldsCleared ? before.fields.length : 0,
      },
    });
    return { ...(await this.present(row)), fieldsCleared };
  }

  /**
   * Replaces the placed fields after {@link validateTemplateFields}: unique
   * ids, known types, labels, and every rect inside its page's visible box.
   */
  async putFields(
    id: string,
    fields: TemplateField[],
    actor: AuditActor,
  ): Promise<Template> {
    const before = await this.loadEditable(id);
    if (!before.page_count) {
      throw new BadRequestException(TEMPLATE_HAS_NO_SOURCE);
    }
    validateFields(fields, before.pages);
    const row = await this.repo.update(id, {
      fields: fields.map(toTemplateFieldRow),
      updated_by: actor.userId ?? null,
    });
    if (!row) {
      throw new NotFoundException(TEMPLATE_NOT_FOUND);
    }
    await this.audit.record({
      action: AUDIT_ACTIONS.documentTemplateFieldsUpdate,
      actor: { ...actor, role: 'admin' },
      targetType: 'document_template',
      targetId: id,
      metadata: {
        beforeCount: before.fields.length,
        afterCount: fields.length,
      },
    });
    return this.present(row);
  }

  /** Presents a row with a presigned `sourceUrl` and its assignment counts. */
  async present(row: DocumentTemplateRow): Promise<Template> {
    const [sourceUrl, [counts], translationUrls] = await Promise.all([
      row.source_key
        ? this.storage.presignGet(row.source_key).then((p) => p.url)
        : null,
      this.counts([row]),
      Promise.all(
        row.translations.flatMap((t) =>
          t.source_key
            ? [
                this.storage
                  .presignGet(t.source_key)
                  .then((p) => [t.language, p.url] as const),
              ]
            : [],
        ),
      ),
    ]);
    return toTemplate(row, sourceUrl, counts, new Map(translationUrls));
  }

  async translationUploadUrl(
    id: string,
    language: DocumentLanguage,
    contentLength: number,
  ): Promise<UploadUrl> {
    await this.loadTranslatable(id, language);
    const { url, expiresAt } = await this.storage.presignPut(
      storageKeys.templateTranslationUpload(id, language),
      { contentType: PDF_CONTENT_TYPE, contentLength },
    );
    return { uploadUrl: url, expiresAt };
  }

  async confirmTranslationSource(
    id: string,
    language: DocumentLanguage,
    actor: AuditActor,
  ): Promise<ConfirmedTemplate> {
    const template = await this.loadTranslatable(id, language);
    const before = findTranslation(template, language);
    const uploadKey = storageKeys.templateTranslationUpload(id, language);
    const normalised = await this.normaliseUpload(uploadKey);
    const sourceKey = storageKeys.templateTranslationSource(id, language);
    await this.storage.put(sourceKey, normalised.bytes, PDF_CONTENT_TYPE);
    const beforeFieldCount = before?.fields.length ?? 0;
    const fieldsCleared =
      before !== null &&
      beforeFieldCount > 0 &&
      !samePageLayout(before.pages, normalised.pages);
    await this.repo.upsertTranslation(id, language, {
      source_key: sourceKey,
      source_sha256: normalised.sha256,
      page_count: normalised.pageCount,
      pages: normalised.pages,
      ...(fieldsCleared || !before ? { fields: [] } : {}),
      updated_by: actor.userId ?? null,
    });
    await this.discardUpload(uploadKey);
    await this.audit.record({
      action: AUDIT_ACTIONS.documentTemplateTranslationSourceReplace,
      actor: { ...actor, role: 'admin' },
      targetType: 'document_template',
      targetId: id,
      metadata: {
        language,
        beforeSha256: before?.source_sha256 ?? null,
        afterSha256: normalised.sha256,
        pageCount: normalised.pageCount,
        sizeBytes: normalised.bytes.byteLength,
        fieldsCleared,
        clearedFieldCount: fieldsCleared ? beforeFieldCount : 0,
      },
    });
    return { ...(await this.present(await this.load(id))), fieldsCleared };
  }

  async putTranslationFields(
    id: string,
    language: DocumentLanguage,
    fields: TemplateField[],
    actor: AuditActor,
  ): Promise<Template> {
    const template = await this.loadTranslatable(id, language);
    const before = findTranslation(template, language);
    if (!before?.page_count) {
      throw new BadRequestException(TEMPLATE_HAS_NO_SOURCE);
    }
    validateFields(fields, before.pages);
    await this.repo.upsertTranslation(id, language, {
      fields: fields.map(toTemplateFieldRow),
      updated_by: actor.userId ?? null,
    });
    await this.audit.record({
      action: AUDIT_ACTIONS.documentTemplateTranslationFieldsUpdate,
      actor: { ...actor, role: 'admin' },
      targetType: 'document_template',
      targetId: id,
      metadata: {
        language,
        beforeCount: before.fields.length,
        afterCount: fields.length,
      },
    });
    return this.present(await this.load(id));
  }

  async removeTranslation(
    id: string,
    language: DocumentLanguage,
    actor: AuditActor,
  ): Promise<Template> {
    const template = await this.loadTranslatable(id, language);
    const before = findTranslation(template, language);
    if (!before || !(await this.repo.deleteTranslation(id, language))) {
      throw new NotFoundException(TRANSLATION_NOT_FOUND);
    }
    await this.discardUpload(
      storageKeys.templateTranslationSource(id, language),
    );
    await this.discardUpload(
      storageKeys.templateTranslationUpload(id, language),
    );
    await this.audit.record({
      action: AUDIT_ACTIONS.documentTemplateTranslationRemove,
      actor: { ...actor, role: 'admin' },
      targetType: 'document_template',
      targetId: id,
      metadata: {
        language,
        sourceSha256: before.source_sha256,
        fieldCount: before.fields.length,
      },
    });
    return this.present(await this.load(id));
  }

  private async counts(rows: DocumentTemplateRow[]): Promise<TemplateCounts[]> {
    const counted = (row: DocumentTemplateRow) =>
      row.status !== 'draft' && row.season !== null;
    const [stats, approvedCount] = await Promise.all([
      this.assignments.templateStats(rows.map((row) => row.id)),
      rows.some(counted) ? this.subjects.countActiveApprovedInstructors() : 0,
    ]);
    return rows.map((row) => {
      const s = stats.get(row.id);
      const hasCompletedAssignments = s?.hasCompleted ?? false;
      return counted(row) && s
        ? {
            hasCompletedAssignments,
            assignedCount: s.assignedCount,
            completedCount: s.completedCount,
            approvedAssignedCount: s.approvedAssignedCount,
            approvedCompletedCount: s.approvedCompletedCount,
            approvedCount,
          }
        : { ...NO_TEMPLATE_COUNTS, hasCompletedAssignments };
    });
  }

  /** {@link load}, then 409 when an assignment of the template is completed. */
  private async loadEditable(id: string): Promise<DocumentTemplateRow> {
    const row = await this.load(id);
    if (await this.assignments.hasCompleted(id)) {
      throw new ConflictException(TEMPLATE_LOCKED);
    }
    return row;
  }

  private async loadTranslatable(
    id: string,
    language: DocumentLanguage,
  ): Promise<DocumentTemplateRow> {
    const row = await this.load(id);
    if (!row.source_language) {
      throw new BadRequestException(TRANSLATION_NEEDS_SOURCE_LANGUAGE);
    }
    if (row.source_language === language) {
      throw new BadRequestException(TRANSLATION_SAME_AS_SOURCE);
    }
    if (await this.assignments.hasCompleted(id)) {
      throw new ConflictException(TEMPLATE_LOCKED);
    }
    return row;
  }

  private async normaliseUpload(
    uploadKey: string,
  ): Promise<NormalisedTemplatePdf> {
    const head = await this.storage.head(uploadKey);
    if (!head) {
      throw new BadRequestException(SOURCE_UPLOAD_MISSING);
    }
    if (head.contentLength > MAX_TEMPLATE_BYTES) {
      await this.discardUpload(uploadKey);
      throw new BadRequestException(SOURCE_TOO_LARGE);
    }
    if (!isPdfContentType(head.contentType)) {
      await this.discardUpload(uploadKey);
      throw new BadRequestException(SOURCE_NOT_PDF);
    }
    return this.pdfQueue.run(async () => {
      const bytes = await this.readUpload(uploadKey);
      try {
        return await normaliseTemplatePdf(bytes);
      } catch (err) {
        if (err instanceof TemplatePdfError) {
          await this.discardUpload(uploadKey);
          throw new BadRequestException(err.message);
        }
        throw err;
      }
    });
  }

  private async readUpload(key: string): Promise<Uint8Array> {
    try {
      const bytes = await this.storage.getBuffer(key, MAX_TEMPLATE_BYTES);
      if (!bytes) {
        throw new BadRequestException(SOURCE_UPLOAD_MISSING);
      }
      return bytes;
    } catch (err) {
      if (err instanceof ObjectTooLargeError) {
        await this.discardUpload(key);
        throw new BadRequestException(SOURCE_TOO_LARGE);
      }
      throw err;
    }
  }

  private async discardUpload(key: string): Promise<void> {
    try {
      await this.storage.delete(key);
    } catch (err) {
      this.logger.warn(
        `Failed to delete template upload ${key}: ${(err as Error).message}`,
      );
    }
  }
}
