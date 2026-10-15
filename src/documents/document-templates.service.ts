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
  normaliseTemplatePdf,
  PDF_CONTENT_TYPE,
  samePageLayout,
  TemplatePdfError,
} from './template-pdf';

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

const UPDATE_FIELDS: [keyof UpdateTemplateDto, keyof DocumentTemplateWrite][] =
  [
    ['titleEn', 'title_en'],
    ['titleZh', 'title_zh'],
    ['descriptionEn', 'description_en'],
    ['descriptionZh', 'description_zh'],
    ['required', 'required'],
    ['sortOrder', 'sort_order'],
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
    const normalised = await this.pdfQueue.run(async () => {
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
    try {
      validateTemplateFields(fields, before.pages);
    } catch (err) {
      if (err instanceof TemplateFieldError) {
        throw new BadRequestException(err.message);
      }
      throw err;
    }
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
    const [sourceUrl, [counts]] = await Promise.all([
      row.source_key
        ? this.storage.presignGet(row.source_key).then((p) => p.url)
        : null,
      this.counts([row]),
    ]);
    return toTemplate(row, sourceUrl, counts);
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
