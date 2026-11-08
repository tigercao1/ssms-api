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
import { DOCUMENT_LANGUAGES, type DocumentLanguage } from './documents.types';
import type {
  CreateFormDto,
  SaveFormDraftDto,
  UpdateFormDto,
} from './dto/form.dto';
import {
  type FormTemplateWrite,
  FormAdminRepository,
} from './form-admin.repository';
import {
  defaultWaiverFields,
  type FormField,
  type FormTemplate,
  type FormTemplateRow,
  type FormTemplateSummary,
  type FormVersion,
  type FormVersionRow,
  SIGNER_EMAIL_KEY,
  SIGNER_NAME_KEY,
} from './form-templates.types';
import { sha256Hex } from './template-pdf';

export const FORM_TEMPLATE_NOT_FOUND = 'Form not found';
export const FORM_SLUG_TAKEN = 'Another document already uses this link name';
export const FORM_DRAFT_CHANGED =
  'This form was changed by someone else; reload it and try again';
export const FORM_NO_DRAFT = 'There is no draft to publish in this language';
export const FORM_NOTHING_TO_UPDATE = 'Nothing to update';
export const FORM_FIELDS_INVALID = (reason: string) =>
  `The field list is not valid: ${reason}`;

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

function toVersion(row: FormVersionRow | undefined): FormVersion | null {
  return row
    ? {
        version: row.version,
        title: row.title,
        bodyMarkdown: row.body_markdown,
        bodySha256: row.body_sha256,
        fields: row.fields,
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
    publishedVersions: byLanguage(
      (l) => versionsOf(row, l).published?.version ?? null,
    ),
    hasDraft: byLanguage((l) => versionsOf(row, l).draft !== undefined),
    updatedAt: row.updated_at,
  };
}

function toFormTemplate(row: FormTemplateRow): FormTemplate {
  return {
    id: row.id,
    slug: row.slug,
    titleEn: row.title_en,
    titleZh: row.title_zh,
    languages: byLanguage((l) => {
      const { published, draft } = versionsOf(row, l);
      return { published: toVersion(published), draft: toVersion(draft) };
    }),
    defaultFields: byLanguage(defaultWaiverFields),
    insertedAt: row.inserted_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Admin editing of `form` templates (customer waivers): metadata, one draft
 * per language, and publishing a draft as the version signers see. Every
 * change is audited.
 */
@Injectable()
export class AdminFormsService {
  constructor(
    private readonly repo: FormAdminRepository,
    private readonly audit: AuditService,
  ) {}

  async list(): Promise<FormTemplateSummary[]> {
    return (await this.repo.list()).map(toSummary);
  }

  async get(id: string): Promise<FormTemplate> {
    return toFormTemplate(await this.load(id));
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
    return toFormTemplate(row);
  }

  async update(
    id: string,
    dto: UpdateFormDto,
    actor: AuditActor,
  ): Promise<FormTemplate> {
    const patch: FormTemplateWrite = {
      ...(dto.titleEn !== undefined && { title_en: dto.titleEn }),
      ...(dto.titleZh !== undefined && { title_zh: dto.titleZh || null }),
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
    return toFormTemplate(row);
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
    const write = {
      title: dto.title,
      body_markdown: dto.bodyMarkdown,
      body_sha256: sha256Hex(Buffer.from(dto.bodyMarkdown, 'utf8')),
      fields,
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
    await this.load(id);
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
    });
    return this.get(id);
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
