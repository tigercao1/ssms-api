import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import {
  AUDIT_ACTIONS,
  type AuditAction,
  type AuditActor,
} from '../audit/audit.types';
import { hasCode, PG_UNIQUE_VIOLATION } from '../database/db-result';
import { DocumentTemplatesService } from './document-templates.service';
import {
  DOCUMENT_LANGUAGES,
  type DocumentLanguage,
  type UploadUrl,
} from './documents.types';
import {
  type CreateFormDto,
  MAX_FORM_PDF_BYTES,
  MAX_FORM_PDF_PAGES,
  type SaveFormDraftDto,
  type UpdateFormDto,
} from './dto/form.dto';
import {
  type FormDraftPatch,
  type FormTemplateWrite,
  FormAdminRepository,
} from './form-admin.repository';
import {
  defaultWaiverFields,
  type FormField,
  type FormOriginalPdf,
  type FormPlacement,
  type FormTemplate,
  type FormTemplateRow,
  type FormTemplateSummary,
  type FormVersion,
  type FormVersionRow,
  SIGNER_EMAIL_KEY,
  SIGNER_NAME_KEY,
} from './form-templates.types';
import { PrivateStorageClient } from './private-storage.client';
import { storageKeys } from './storage-keys';
import { insidePageBox } from './template-fields';
import { PDF_CONTENT_TYPE, samePageLayout, sha256Hex } from './template-pdf';

export const FORM_TEMPLATE_NOT_FOUND = 'Form not found';
export const FORM_SLUG_TAKEN = 'Another document already uses this link name';
export const FORM_DRAFT_CHANGED =
  'This form was changed by someone else; reload it and try again';
export const FORM_NO_DRAFT = 'There is no draft to publish in this language';
export const FORM_NOTHING_TO_UPDATE = 'Nothing to update';
export const FORM_FIELDS_INVALID = (reason: string) =>
  `The field list is not valid: ${reason}`;
export const FORM_NEEDS_DRAFT =
  'Save a draft in this language before changing its PDF';
export const FORM_NO_SOURCE = 'This draft has no original PDF';
export const FORM_PLACEMENT_INVALID = (reason: string) =>
  `The field positions are not valid: ${reason}`;
export const FORM_PLACEMENTS_MISSING = (keys: string[]) =>
  `Place these required fields on the PDF before publishing: ${keys.join(', ')}`;

const NO_SOURCE = {
  source_key: null,
  source_sha256: null,
  source_size_bytes: null,
  page_count: null,
  pages: [],
  placements: [],
};

type SourceUrls = Map<string, { url: string; expiresAt: string }>;

function validateFields(fields: readonly FormField[]): void {
  const keys = new Set<string>();
  for (const field of fields) {
    if (keys.has(field.key)) {
      throw new BadRequestException(
        FORM_FIELDS_INVALID(`${field.key} appears twice`),
      );
    }
    keys.add(field.key);
  }
  const has = (key: string, type: FormField['type']) =>
    fields.some((f) => f.key === key && f.type === type && f.required);
  if (!has(SIGNER_NAME_KEY, 'text') || !has(SIGNER_EMAIL_KEY, 'email')) {
    throw new BadRequestException(
      FORM_FIELDS_INVALID(
        `it needs a required ${SIGNER_NAME_KEY} text field and a required ${SIGNER_EMAIL_KEY} email field`,
      ),
    );
  }
  if (!fields.some((f) => f.type === 'signature' && f.required)) {
    throw new BadRequestException(
      FORM_FIELDS_INVALID('it needs a required signature field'),
    );
  }
}

function validatePlacements(
  placements: readonly FormPlacement[],
  version: FormVersionRow,
): void {
  const keys = new Set(version.fields.map((f) => f.key));
  for (const placement of placements) {
    const page = version.pages[placement.page - 1];
    const problem = !keys.has(placement.key)
      ? `${placement.key} is not a field of this version`
      : !page
        ? `${placement.key} is on page ${placement.page}, but the PDF has ${version.pages.length} page(s)`
        : !insidePageBox(placement, page)
          ? `${placement.key} is outside page ${placement.page}`
          : null;
    if (problem) {
      throw new BadRequestException(FORM_PLACEMENT_INVALID(problem));
    }
  }
}

function unplacedRequired(version: FormVersionRow): string[] {
  const placed = new Set(version.placements.map((p) => p.key));
  return version.fields
    .filter((f) => f.required && !placed.has(f.key))
    .map((f) => f.key);
}

function toOriginalPdf(
  row: FormVersionRow,
  urls: SourceUrls,
): FormOriginalPdf | null {
  const signed = row.source_key ? urls.get(row.source_key) : undefined;
  return signed
    ? {
        sha256: row.source_sha256!,
        sizeBytes: row.source_size_bytes!,
        pageCount: row.page_count!,
        pages: row.pages,
        url: signed.url,
        urlExpiresAt: signed.expiresAt,
      }
    : null;
}

function toVersion(
  row: FormVersionRow | undefined,
  urls: SourceUrls,
): FormVersion | null {
  return row
    ? {
        version: row.version,
        title: row.title,
        bodyMarkdown: row.body_markdown,
        bodySha256: row.body_sha256,
        fields: row.fields,
        originalPdf: toOriginalPdf(row, urls),
        placements: row.placements,
        publishedAt: row.published_at,
        updatedAt: row.updated_at,
      }
    : null;
}

function versionsOf(row: FormTemplateRow, language: DocumentLanguage) {
  const own = row.versions
    .filter((v) => v.language === language)
    .sort((a, b) => b.version - a.version);
  return {
    published: own.find((v) => v.published_at !== null),
    draft: own.find((v) => v.published_at === null),
    latest: own[0],
  };
}

function byLanguage<T>(
  fn: (language: DocumentLanguage) => T,
): Record<DocumentLanguage, T> {
  return Object.fromEntries(
    DOCUMENT_LANGUAGES.map((language) => [language, fn(language)]),
  ) as Record<DocumentLanguage, T>;
}

function toSummary(row: FormTemplateRow): FormTemplateSummary {
  return {
    id: row.id,
    slug: row.slug,
    titleEn: row.title_en,
    titleZh: row.title_zh,
    emailCopy: row.email_copy,
    publishedVersions: byLanguage(
      (l) => versionsOf(row, l).published?.version ?? null,
    ),
    hasDraft: byLanguage((l) => versionsOf(row, l).draft !== undefined),
    updatedAt: row.updated_at,
  };
}

function toFormTemplate(row: FormTemplateRow, urls: SourceUrls): FormTemplate {
  return {
    id: row.id,
    slug: row.slug,
    titleEn: row.title_en,
    titleZh: row.title_zh,
    emailCopy: row.email_copy,
    languages: byLanguage((l) => {
      const { published, draft } = versionsOf(row, l);
      return {
        published: toVersion(published, urls),
        draft: toVersion(draft, urls),
      };
    }),
    defaultFields: byLanguage(defaultWaiverFields),
    insertedAt: row.inserted_at,
    updatedAt: row.updated_at,
  };
}

@Injectable()
export class AdminFormsService {
  constructor(
    private readonly repo: FormAdminRepository,
    private readonly audit: AuditService,
    private readonly templates: DocumentTemplatesService,
    private readonly storage: PrivateStorageClient,
  ) {}

  async list(): Promise<FormTemplateSummary[]> {
    return (await this.repo.list()).map(toSummary);
  }

  async get(id: string): Promise<FormTemplate> {
    return this.present(await this.load(id));
  }

  async create(dto: CreateFormDto, actor: AuditActor): Promise<FormTemplate> {
    let row: FormTemplateRow;
    try {
      row = await this.repo.insert({
        slug: dto.slug,
        title_en: dto.titleEn,
        title_zh: dto.titleZh ?? null,
        updated_by: actor.userId ?? null,
      });
    } catch (err) {
      if (hasCode(err, PG_UNIQUE_VIOLATION)) {
        throw new ConflictException(FORM_SLUG_TAKEN);
      }
      throw err;
    }
    await this.record(AUDIT_ACTIONS.documentTemplateCreate, row.id, actor, {
      kind: 'form',
      slug: row.slug,
    });
    return this.present(row);
  }

  async update(
    id: string,
    dto: UpdateFormDto,
    actor: AuditActor,
  ): Promise<FormTemplate> {
    const patch: FormTemplateWrite = {
      ...(dto.titleEn !== undefined && { title_en: dto.titleEn }),
      ...(dto.titleZh !== undefined && { title_zh: dto.titleZh || null }),
      ...(dto.emailCopy !== undefined && { email_copy: dto.emailCopy }),
    };
    if (Object.keys(patch).length === 0) {
      throw new BadRequestException(FORM_NOTHING_TO_UPDATE);
    }
    const row = await this.repo.update(id, {
      ...patch,
      updated_by: actor.userId ?? null,
    });
    if (!row) {
      throw new NotFoundException(FORM_TEMPLATE_NOT_FOUND);
    }
    await this.record(AUDIT_ACTIONS.documentTemplateUpdate, id, actor, {
      kind: 'form',
      after: patch,
    });
    return this.present(row);
  }

  async saveDraft(
    id: string,
    language: DocumentLanguage,
    dto: SaveFormDraftDto,
    actor: AuditActor,
  ): Promise<FormTemplate> {
    const { draft, published, latest } = versionsOf(
      await this.load(id),
      language,
    );
    const fields =
      dto.fields ??
      draft?.fields ??
      published?.fields ??
      defaultWaiverFields(language);
    validateFields(fields);
    const keys = new Set(fields.map((f) => f.key));
    const source = draft ?? published;
    const write = {
      title: dto.title,
      body_markdown: dto.bodyMarkdown,
      body_sha256: sha256Hex(Buffer.from(dto.bodyMarkdown, 'utf8')),
      fields,
      ...(source?.source_key
        ? {
            source_key: source.source_key,
            source_sha256: source.source_sha256,
            source_size_bytes: source.source_size_bytes,
            page_count: source.page_count,
            pages: source.pages,
            placements: source.placements.filter((p) => keys.has(p.key)),
          }
        : NO_SOURCE),
      updated_by: actor.userId ?? null,
    };
    let saved: FormVersionRow | null;
    try {
      saved =
        (draft && (await this.repo.updateDraft(id, language, write))) ||
        (await this.repo.insertDraft(
          id,
          language,
          (latest?.version ?? 0) + 1,
          write,
        ));
    } catch (err) {
      if (hasCode(err, PG_UNIQUE_VIOLATION)) {
        throw new ConflictException(FORM_DRAFT_CHANGED);
      }
      throw err;
    }
    await this.record(AUDIT_ACTIONS.documentFormDraftSave, id, actor, {
      language,
      version: saved.version,
      bodySha256: saved.body_sha256,
    });
    return this.get(id);
  }

  async publish(
    id: string,
    language: DocumentLanguage,
    actor: AuditActor,
    now = new Date(),
  ): Promise<FormTemplate> {
    const { draft } = versionsOf(await this.load(id), language);
    const missing = draft?.source_key ? unplacedRequired(draft) : [];
    if (missing.length > 0) {
      throw new BadRequestException(FORM_PLACEMENTS_MISSING(missing));
    }
    const published = await this.repo.publishDraft(
      id,
      language,
      actor.userId ?? null,
      now.toISOString(),
    );
    if (!published) {
      throw new BadRequestException(FORM_NO_DRAFT);
    }
    await this.record(AUDIT_ACTIONS.documentTemplatePublish, id, actor, {
      kind: 'form',
      language,
      version: published.version,
      bodySha256: published.body_sha256,
      sourceSha256: published.source_sha256,
    });
    return this.get(id);
  }

  async sourceUploadUrl(
    id: string,
    language: DocumentLanguage,
    contentLength: number,
  ): Promise<UploadUrl> {
    const draft = await this.loadDraft(id, language);
    const { url, expiresAt } = await this.storage.presignPut(
      storageKeys.formUpload(id, language, draft.version),
      { contentType: PDF_CONTENT_TYPE, contentLength },
    );
    return { uploadUrl: url, expiresAt };
  }

  async confirmSource(
    id: string,
    language: DocumentLanguage,
    actor: AuditActor,
  ): Promise<FormTemplate & { placementsCleared: boolean }> {
    const draft = await this.loadDraft(id, language);
    const uploadKey = storageKeys.formUpload(id, language, draft.version);
    const normalised = await this.templates.normaliseUpload(uploadKey, {
      maxBytes: MAX_FORM_PDF_BYTES,
      maxPages: MAX_FORM_PDF_PAGES,
    });
    const sourceKey = storageKeys.formSource(id, language, draft.version);
    await this.storage.put(sourceKey, normalised.bytes, PDF_CONTENT_TYPE);
    const placementsCleared =
      draft.placements.length > 0 &&
      !samePageLayout(draft.pages, normalised.pages);
    await this.updateDraft(id, language, {
      source_key: sourceKey,
      source_sha256: normalised.sha256,
      source_size_bytes: normalised.bytes.byteLength,
      page_count: normalised.pageCount,
      pages: normalised.pages,
      placements: placementsCleared ? [] : draft.placements,
      updated_by: actor.userId ?? null,
    });
    await this.templates.discardUpload(uploadKey);
    await this.record(AUDIT_ACTIONS.documentTemplateSourceReplace, id, actor, {
      kind: 'form',
      language,
      version: draft.version,
      beforeSha256: draft.source_sha256,
      afterSha256: normalised.sha256,
      pageCount: normalised.pageCount,
      sizeBytes: normalised.bytes.byteLength,
      placementsCleared,
    });
    return { ...(await this.get(id)), placementsCleared };
  }

  async removeSource(
    id: string,
    language: DocumentLanguage,
    actor: AuditActor,
  ): Promise<FormTemplate> {
    const draft = await this.loadDraft(id, language);
    if (!draft.source_key) {
      throw new NotFoundException(FORM_NO_SOURCE);
    }
    await this.updateDraft(id, language, {
      ...NO_SOURCE,
      updated_by: actor.userId ?? null,
    });
    const ownKey = storageKeys.formSource(id, language, draft.version);
    if (draft.source_key === ownKey) {
      await this.templates.discardUpload(ownKey);
    }
    await this.record(AUDIT_ACTIONS.documentFormSourceRemove, id, actor, {
      language,
      version: draft.version,
      sourceSha256: draft.source_sha256,
    });
    return this.get(id);
  }

  async putPlacements(
    id: string,
    language: DocumentLanguage,
    placements: FormPlacement[],
    actor: AuditActor,
  ): Promise<FormTemplate> {
    const draft = await this.loadDraft(id, language);
    if (!draft.source_key) {
      throw new BadRequestException(FORM_NO_SOURCE);
    }
    validatePlacements(placements, draft);
    await this.updateDraft(id, language, {
      placements,
      updated_by: actor.userId ?? null,
    });
    await this.record(AUDIT_ACTIONS.documentFormPlacementsUpdate, id, actor, {
      language,
      version: draft.version,
      beforeCount: draft.placements.length,
      afterCount: placements.length,
    });
    return this.get(id);
  }

  private async present(row: FormTemplateRow): Promise<FormTemplate> {
    const keys = new Set(
      DOCUMENT_LANGUAGES.flatMap((l) => {
        const { published, draft } = versionsOf(row, l);
        return [published?.source_key, draft?.source_key].filter(
          (key): key is string => !!key,
        );
      }),
    );
    const urls: SourceUrls = new Map(
      await Promise.all(
        [...keys].map(
          async (key) => [key, await this.storage.presignGet(key)] as const,
        ),
      ),
    );
    return toFormTemplate(row, urls);
  }

  private async loadDraft(
    id: string,
    language: DocumentLanguage,
  ): Promise<FormVersionRow> {
    const { draft } = versionsOf(await this.load(id), language);
    if (!draft) {
      throw new BadRequestException(FORM_NEEDS_DRAFT);
    }
    return draft;
  }

  private async updateDraft(
    id: string,
    language: DocumentLanguage,
    patch: FormDraftPatch,
  ): Promise<void> {
    if (!(await this.repo.updateDraft(id, language, patch))) {
      throw new ConflictException(FORM_DRAFT_CHANGED);
    }
  }

  private async load(id: string): Promise<FormTemplateRow> {
    const row = await this.repo.findById(id);
    if (!row) {
      throw new NotFoundException(FORM_TEMPLATE_NOT_FOUND);
    }
    return row;
  }

  private record(
    action: AuditAction,
    id: string,
    actor: AuditActor,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    return this.audit.record({
      action,
      actor: { ...actor, role: 'admin' },
      targetType: 'document_template',
      targetId: id,
      metadata,
    });
  }
}
