import {
  BadRequestException,
  ConflictException,
  GoneException,
  Injectable,
  Logger,
  NotFoundException,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { AUDIT_ACTIONS, type AuditActor } from '../audit/audit.types';
import { likePattern, searchTokens } from '../database/db-result';
import { pageOffset } from '../database/pagination';
import { exportDownloadName, exportFolderName } from './document-export-files';
import { DocumentExportQueue } from './document-export-queue';
import { writeSignedCopiesZip } from './document-export-zip';
import {
  toDocumentExport,
  toTemplateAssignmentRow,
} from './document-exports.presenters';
import { DocumentExportsRepository } from './document-exports.repository';
import type {
  DocumentExport,
  DocumentExportRow,
  DocumentExportUrl,
  TemplateAssignmentDbRow,
  TemplateAssignmentPage,
  TemplateAssignmentQuery,
} from './document-exports.types';
import { DocumentTemplatesRepository } from './document-templates.repository';
import { TEMPLATE_NOT_FOUND } from './document-templates.service';
import type { DocumentTemplateRow } from './documents.types';
import {
  type CreateDocumentExportDto,
  MAX_EXPORT_FILES,
  TEMPLATE_ASSIGNMENTS_DEFAULT_LIMIT,
  type TemplateAssignmentsQueryDto,
} from './dto/export.dto';
import { PrivateStorageClient } from './private-storage.client';
import { storageKeys } from './storage-keys';

export const EXPORT_RETENTION_MS = 24 * 60 * 60 * 1000;
export const RECENT_EXPORTS_LIMIT = 10;

export const EXPORT_NOT_FOUND = 'Document export not found';
export const EXPORT_NOT_SIGN_TEMPLATE =
  'Only sign documents have signed copies to export';
export const EXPORT_TOO_MANY = `An export holds at most ${MAX_EXPORT_FILES} signed copies`;
export const EXPORT_NOTHING_COMPLETED = 'No completed signed copies match';
export const EXPORT_INVALID_ASSIGNMENTS =
  'Every assignment must be a completed, signed copy of this template in the chosen season';
export const EXPORT_NOT_READY = 'Export is not ready';
export const EXPORT_EXPIRED = 'Export has expired';
export const EXPORT_FAILED = 'Export failed; please try again';
export const EXPORT_INTERRUPTED = 'Export was interrupted by a server restart';

/**
 * The signed-copies index of a template and its bulk ZIP exports. Exports are
 * recorded as `queued`, built one at a time by {@link DocumentExportQueue},
 * and downloaded through a short-lived presigned URL.
 */
@Injectable()
export class DocumentExportsService implements OnApplicationBootstrap {
  private readonly logger = new Logger(DocumentExportsService.name);

  constructor(
    private readonly exports: DocumentExportsRepository,
    private readonly templates: DocumentTemplatesRepository,
    private readonly storage: PrivateStorageClient,
    private readonly queue: DocumentExportQueue,
    private readonly audit: AuditService,
  ) {}

  /** Marks exports a previous process left `queued` or `running` as `failed`. */
  async onApplicationBootstrap(): Promise<void> {
    try {
      const failed = await this.exports.failUnfinished(
        EXPORT_INTERRUPTED,
        new Date().toISOString(),
      );
      if (failed > 0) {
        this.logger.warn(`Marked ${failed} interrupted export(s) failed.`);
      }
    } catch (err) {
      this.logger.error(
        `Recovering interrupted exports failed: ${errorMessage(err)}`,
      );
    }
  }

  /**
   * `GET /admin/documents/templates/:id/assignments`: completed first (newest
   * signing first), then open ones by instructor last name. 404 unknown template.
   */
  async listAssignments(
    templateId: string,
    query: TemplateAssignmentsQueryDto,
  ): Promise<TemplateAssignmentPage> {
    await this.requireTemplate(templateId);
    const limit = query.limit ?? TEMPLATE_ASSIGNMENTS_DEFAULT_LIMIT;
    const filter: TemplateAssignmentQuery = {
      templateId,
      season: query.season ?? null,
      status: query.status ?? 'all',
      patterns: searchTokens(query.q).map((token) => likePattern(token)),
      ids: null,
      signedOnly: false,
      limit,
      offset: pageOffset(query.page ?? 1, limit),
    };
    const rows = await this.exports.listTemplateAssignments(filter);
    const total =
      rows[0]?.total_count ??
      (filter.offset > 0 ? await this.countAssignments(filter) : 0);
    return { rows: rows.map(toTemplateAssignmentRow), total };
  }

  /**
   * `POST /admin/documents/templates/:id/exports`: validates, records a
   * `queued` export and queues it. Only completed rows with a signed copy
   * count, intersected with `season` when one is given. 404 unknown template;
   * 400 for a `read` template, an id outside that set, nothing to export, or
   * more than {@link MAX_EXPORT_FILES} matches.
   */
  async create(
    templateId: string,
    dto: CreateDocumentExportDto,
    actor: AuditActor,
  ): Promise<DocumentExport> {
    const template = await this.requireTemplate(templateId);
    if (template.kind !== 'sign') {
      throw new BadRequestException(EXPORT_NOT_SIGN_TEMPLATE);
    }
    const season = dto.season ?? null;
    const ids = dto.assignmentIds ? [...new Set(dto.assignmentIds)] : null;
    const matched = ids
      ? await this.checkSelection(templateId, season, ids)
      : await this.countAssignments(exportable(templateId, season, null, 1));
    if (matched === 0) {
      throw new BadRequestException(EXPORT_NOTHING_COMPLETED);
    }
    if (matched > MAX_EXPORT_FILES) {
      throw new BadRequestException(EXPORT_TOO_MANY);
    }
    const row = await this.exports.insert({
      template_id: templateId,
      season,
      assignment_ids: ids,
      requested_by: actor.userId as string,
    });
    await this.audit.record({
      action: AUDIT_ACTIONS.documentExportCreate,
      actor: { ...actor, role: 'admin' },
      targetType: 'document_export',
      targetId: row.id,
      metadata: {
        templateId,
        season,
        selectedCount: ids?.length ?? null,
        matchedCount: matched,
      },
    });
    this.queue.enqueue(() => this.run(row.id));
    return toDocumentExport(row);
  }

  /** `GET /admin/documents/templates/:id/exports`: the latest 10. 404 unknown template. */
  async listForTemplate(templateId: string): Promise<DocumentExport[]> {
    await this.requireTemplate(templateId);
    const rows = await this.exports.listForTemplate(
      templateId,
      RECENT_EXPORTS_LIMIT,
    );
    return rows.map(toDocumentExport);
  }

  /** `GET /admin/documents/exports/:exportId`. 404 unknown. */
  async get(exportId: string): Promise<DocumentExport> {
    return toDocumentExport(await this.requireExport(exportId));
  }

  /**
   * `GET /admin/documents/exports/:exportId/url`: a 5-minute presigned GET of
   * the ZIP. 404 unknown, 410 expired, 409 not `ready`.
   */
  async downloadUrl(
    exportId: string,
    actor: AuditActor,
    now: Date = new Date(),
  ): Promise<DocumentExportUrl> {
    const row = await this.requireExport(exportId);
    if (
      row.status === 'expired' ||
      (row.status === 'ready' &&
        row.expires_at !== null &&
        Date.parse(row.expires_at) <= now.getTime())
    ) {
      throw new GoneException(EXPORT_EXPIRED);
    }
    if (row.status !== 'ready' || !row.zip_key) {
      throw new ConflictException(EXPORT_NOT_READY);
    }
    const template = await this.requireTemplate(row.template_id);
    const filename = exportDownloadName(template.title_en, row.season);
    const { url, expiresAt } = await this.storage.presignGet(row.zip_key, {
      contentDisposition: `attachment; filename="${filename}"`,
    });
    await this.audit.record({
      action: AUDIT_ACTIONS.documentExportDownload,
      actor: { ...actor, role: 'admin' },
      targetType: 'document_export',
      targetId: row.id,
      metadata: {
        templateId: row.template_id,
        season: row.season,
        fileCount: row.file_count,
        sizeBytes: row.size_bytes,
      },
    });
    return {
      url,
      expiresAt,
      sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes),
    };
  }

  /**
   * Builds one export: claims it (`queued` → `running`), streams the ZIP to
   * `exports/<id>.zip`, then marks it `ready` for 24 hours or `failed`.
   */
  async run(exportId: string): Promise<void> {
    const startedAt = new Date().toISOString();
    const row = await this.exports.updateIfStatus(exportId, ['queued'], {
      status: 'running',
      started_at: startedAt,
    });
    if (!row) {
      return;
    }
    const key = storageKeys.documentExport(row.id);
    try {
      const template = await this.requireTemplate(row.template_id);
      const rows = await this.exportRows(row);
      const result = await writeSignedCopiesZip({
        storage: this.storage,
        key,
        folder: exportFolderName(template.title_en, row.season),
        rows,
      });
      const finishedAt = new Date();
      const ready = await this.exports.updateIfStatus(row.id, ['running'], {
        status: 'ready',
        file_count: result.fileCount,
        skipped_count: result.skippedCount,
        size_bytes: result.sizeBytes,
        zip_key: key,
        finished_at: finishedAt.toISOString(),
        expires_at: new Date(
          finishedAt.getTime() + EXPORT_RETENTION_MS,
        ).toISOString(),
      });
      if (!ready) {
        await this.storage.delete(key);
      }
      this.logger.log(
        `Export ${row.id}: ${result.fileCount} file(s), ${result.skippedCount} skipped, ` +
          `${result.sizeBytes} bytes.`,
      );
    } catch (err) {
      this.logger.error(`Export ${row.id} failed: ${errorMessage(err)}`);
      await this.exports.updateIfStatus(row.id, ['running'], {
        status: 'failed',
        error: EXPORT_FAILED,
        finished_at: new Date().toISOString(),
      });
    }
  }

  private async exportRows(
    row: DocumentExportRow,
  ): Promise<TemplateAssignmentDbRow[]> {
    return this.exports.listTemplateAssignments(
      exportable(
        row.template_id,
        row.season,
        row.assignment_ids,
        MAX_EXPORT_FILES,
      ),
    );
  }

  private async checkSelection(
    templateId: string,
    season: string | null,
    ids: string[],
  ): Promise<number> {
    const rows = await this.exports.listTemplateAssignments(
      exportable(templateId, season, ids, ids.length),
    );
    if (rows.length !== ids.length) {
      throw new BadRequestException(EXPORT_INVALID_ASSIGNMENTS);
    }
    return rows.length;
  }

  private async countAssignments(
    filter: TemplateAssignmentQuery,
  ): Promise<number> {
    const [first] = await this.exports.listTemplateAssignments({
      ...filter,
      limit: 1,
      offset: 0,
    });
    return first?.total_count ?? 0;
  }

  private async requireTemplate(id: string): Promise<DocumentTemplateRow> {
    const template = await this.templates.findById(id);
    if (!template) {
      throw new NotFoundException(TEMPLATE_NOT_FOUND);
    }
    return template;
  }

  private async requireExport(id: string): Promise<DocumentExportRow> {
    const row = await this.exports.findById(id);
    if (!row) {
      throw new NotFoundException(EXPORT_NOT_FOUND);
    }
    return row;
  }
}

function exportable(
  templateId: string,
  season: string | null,
  ids: string[] | null,
  limit: number,
): TemplateAssignmentQuery {
  return {
    templateId,
    season,
    status: 'completed',
    patterns: [],
    ids,
    signedOnly: true,
    limit,
    offset: 0,
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
