import { randomUUID } from 'node:crypto';
import {
  DatabaseError,
  PG_UNIQUE_VIOLATION,
} from '../../src/database/db-result';
import {
  FormAdminRepository,
  type FormDraftPatch,
  type FormDraftSource,
  type FormTemplateWrite,
} from '../../src/documents/form-admin.repository';
import {
  FORM_COPY_EMAIL_LIMITS,
  FormSigningRepository,
  type NewSignedFormAssignment,
} from '../../src/documents/form-signing.repository';
import type {
  DocumentAssignmentRow,
  DocumentLanguage,
} from '../../src/documents/documents.types';
import {
  defaultWaiverFields,
  type FormTemplateRow,
  type FormVersionRow,
  type PublishedForm,
  type SignatureLookupRow,
} from '../../src/documents/form-templates.types';
import { sha256Hex } from '../../src/documents/template-pdf';

export interface FakeCustomer {
  id: string;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  shopify_customer_id: number | null;
}

interface FakeForm {
  templateId: string;
  slug: string;
  titleEn: string;
  titleZh: string | null;
  emailCopy: boolean;
  versions: FormVersionRow[];
}

export function formVersion(
  templateId: string,
  language: DocumentLanguage,
  version: number,
  overrides: Partial<FormVersionRow> = {},
): FormVersionRow {
  const body =
    overrides.body_markdown ??
    `# Release of liability v${version}\n\nI accept the **risks** of skiing.\n\n- Wear a helmet\n- Follow the instructor`;
  return {
    template_id: templateId,
    language,
    version,
    title: language === 'en' ? 'Lesson waiver' : '课程免责声明',
    body_markdown: body,
    body_sha256: sha256Hex(Buffer.from(body, 'utf8')),
    fields: defaultWaiverFields(language),
    source_key: null,
    source_sha256: null,
    source_size_bytes: null,
    page_count: null,
    pages: [],
    placements: [],
    published_at: '2026-11-01T00:00:00.000Z',
    published_by: null,
    updated_by: null,
    inserted_at: '2026-11-01T00:00:00.000Z',
    updated_at: '2026-11-01T00:00:00.000Z',
    ...overrides,
  };
}

export class InMemoryFormSigningRepository extends FormSigningRepository {
  readonly forms: FakeForm[] = [];
  readonly customers: FakeCustomer[] = [];
  readonly signed: (NewSignedFormAssignment & {
    subject_type: 'customer';
    status: 'completed';
  })[] = [];
  failInsert = false;
  failCopyEmailClaim = false;
  readonly copyEmailClaims: { emailHash: string; at: number }[] = [];

  seedForm(
    slug: string,
    versions: FormVersionRow[] = [],
    emailCopy = true,
  ): string {
    const templateId = versions[0]?.template_id ?? randomUUID();
    this.forms.push({
      templateId,
      slug,
      titleEn: 'Lesson waiver',
      titleZh: '课程免责声明',
      emailCopy,
      versions,
    });
    return templateId;
  }

  seedCustomer(customer: Partial<FakeCustomer>): FakeCustomer {
    const row: FakeCustomer = {
      id: randomUUID(),
      email: null,
      first_name: null,
      last_name: null,
      shopify_customer_id: null,
      ...customer,
    };
    this.customers.push(row);
    return row;
  }

  findPublished(
    slug: string,
    language: DocumentLanguage,
  ): Promise<PublishedForm | null> {
    const form = this.forms.find((f) => f.slug === slug);
    const version = form?.versions
      .filter((v) => v.language === language && v.published_at !== null)
      .sort((a, b) => b.version - a.version)[0];
    return Promise.resolve(
      form && version
        ? {
            templateId: form.templateId,
            slug: form.slug,
            titleEn: form.titleEn,
            titleZh: form.titleZh,
            emailCopy: form.emailCopy,
            version,
          }
        : null,
    );
  }

  customerForEmail(
    email: string,
    firstName: string | null,
    lastName: string | null,
  ): Promise<string> {
    const key = email.trim().toLowerCase();
    const match = this.customers
      .filter((c) => c.email?.toLowerCase() === key)
      .sort(
        (a, b) =>
          Number(a.shopify_customer_id === null) -
          Number(b.shopify_customer_id === null),
      )[0];
    return Promise.resolve(
      match?.id ??
        this.seedCustomer({
          email: key,
          first_name: firstName,
          last_name: lastName,
        }).id,
    );
  }

  claimCopyEmail(emailHash: string): Promise<boolean> {
    if (this.failCopyEmailClaim) {
      return Promise.reject(new Error('claim failed'));
    }
    const now = Date.now();
    const since = (seconds: number) =>
      this.copyEmailClaims.filter((c) => c.at > now - seconds * 1000);
    const accepted =
      since(FORM_COPY_EMAIL_LIMITS.recipientWindowSeconds).filter(
        (c) => c.emailHash === emailHash,
      ).length < FORM_COPY_EMAIL_LIMITS.perRecipient &&
      since(FORM_COPY_EMAIL_LIMITS.globalWindowSeconds).length <
        FORM_COPY_EMAIL_LIMITS.global;
    if (accepted) {
      this.copyEmailClaims.push({ emailHash, at: now });
    }
    return Promise.resolve(accepted);
  }

  insertSigned(row: NewSignedFormAssignment): Promise<DocumentAssignmentRow> {
    if (this.failInsert) {
      return Promise.reject(new Error('insert failed'));
    }
    const stored = {
      ...row,
      subject_type: 'customer' as const,
      status: 'completed' as const,
    };
    this.signed.push(stored);
    return Promise.resolve({
      season: null,
      class_id: null,
      assigned_at: row.completed_at!,
      viewed_at: null,
      due_at: null,
      reminder_sent_at: null,
      language: null,
      signer_name: null,
      signer_email: null,
      signer_ip: null,
      signer_user_agent: null,
      consent_at: null,
      template_sha256: null,
      signed_key: null,
      signed_sha256: null,
      completed_at: null,
      field_values: {},
      inserted_at: row.completed_at!,
      updated_at: row.completed_at!,
      template: null,
      ...stored,
    });
  }
}

const uniqueViolation = () =>
  new DatabaseError('insert', PG_UNIQUE_VIOLATION, 'duplicate key');

export class InMemoryFormAdminRepository extends FormAdminRepository {
  readonly forms = new Map<string, FormTemplateRow>();
  lookupRows: SignatureLookupRow[] = [];
  checkRows = new Map<string, { title_en: string; signed_at: string }[]>();
  readonly checkCalls: string[] = [];
  studentRows: { name: string | null; signed_at: string | null }[] = [];
  readonly lookupCalls: { query: string; limit: number }[] = [];
  readonly studentCalls: {
    instructorId: string;
    query: string;
    limit: number;
  }[] = [];

  private writes = 0;

  list(): Promise<FormTemplateRow[]> {
    return Promise.resolve(structuredClone([...this.forms.values()]));
  }

  findById(id: string): Promise<FormTemplateRow | null> {
    const form = this.forms.get(id);
    return Promise.resolve(form ? structuredClone(form) : null);
  }

  private touch(row: FormVersionRow, patch: Partial<FormVersionRow>) {
    this.writes += 1;
    Object.assign(row, patch, {
      updated_at: new Date(
        Date.UTC(2026, 10, 1, 0, 0, this.writes),
      ).toISOString(),
    });
    return structuredClone(row);
  }

  insert(
    row: FormTemplateWrite & { slug: string; title_en: string },
  ): Promise<FormTemplateRow> {
    if ([...this.forms.values()].some((f) => f.slug === row.slug)) {
      return Promise.reject(uniqueViolation());
    }
    const form: FormTemplateRow = {
      id: randomUUID(),
      slug: row.slug,
      title_en: row.title_en,
      title_zh: row.title_zh ?? null,
      email_copy: true,
      inserted_at: '2026-11-01T00:00:00.000Z',
      updated_at: '2026-11-01T00:00:00.000Z',
      versions: [],
    };
    this.forms.set(form.id, form);
    return Promise.resolve(form);
  }

  update(
    id: string,
    patch: FormTemplateWrite,
    expectedUpdatedAt?: string,
  ): Promise<FormTemplateRow | null> {
    const form = this.forms.get(id);
    if (
      !form ||
      (expectedUpdatedAt !== undefined && form.updated_at !== expectedUpdatedAt)
    ) {
      return Promise.resolve(null);
    }
    this.writes += 1;
    Object.assign(form, {
      ...(patch.title_en !== undefined && { title_en: patch.title_en }),
      ...(patch.title_zh !== undefined && { title_zh: patch.title_zh }),
      ...(patch.email_copy !== undefined && { email_copy: patch.email_copy }),
      updated_at: new Date(
        Date.UTC(2026, 10, 1, 0, 0, this.writes),
      ).toISOString(),
    });
    return Promise.resolve(structuredClone(form));
  }

  private draftOf(templateId: string, language: DocumentLanguage) {
    return this.forms
      .get(templateId)
      ?.versions.find((v) => v.language === language && !v.published_at);
  }

  updateDraft(
    templateId: string,
    language: DocumentLanguage,
    expected: FormDraftSource,
    draft: FormDraftPatch,
    expectedUpdatedAt?: string,
  ): Promise<FormVersionRow | null> {
    const row = this.draftOf(templateId, language);
    return Promise.resolve(
      row &&
        row.source_key === expected.source_key &&
        row.source_sha256 === expected.source_sha256 &&
        (expectedUpdatedAt === undefined ||
          row.updated_at === expectedUpdatedAt)
        ? this.touch(row, draft)
        : null,
    );
  }

  insertDraft(
    templateId: string,
    language: DocumentLanguage,
    version: number,
    draft: Parameters<FormAdminRepository['insertDraft']>[3],
  ): Promise<FormVersionRow> {
    const form = this.forms.get(templateId)!;
    if (
      this.draftOf(templateId, language) ||
      form.versions.some(
        (v) => v.language === language && v.version === version,
      )
    ) {
      return Promise.reject(uniqueViolation());
    }
    const row = formVersion(templateId, language, version, {
      ...draft,
      published_at: null,
    });
    form.versions.push(row);
    return Promise.resolve(structuredClone(row));
  }

  publishDraft(
    templateId: string,
    language: DocumentLanguage,
    expectedUpdatedAt: string,
    publishedBy: string | null,
    publishedAt: string,
  ): Promise<FormVersionRow | null> {
    const row = this.draftOf(templateId, language);
    return Promise.resolve(
      row && row.updated_at === expectedUpdatedAt
        ? this.touch(row, {
            published_at: publishedAt,
            published_by: publishedBy,
          })
        : null,
    );
  }

  lookupSignatures(
    query: string,
    limit: number,
  ): Promise<SignatureLookupRow[]> {
    this.lookupCalls.push({ query, limit });
    return Promise.resolve(this.lookupRows);
  }

  signatureCheck(
    email: string,
  ): Promise<{ title_en: string; signed_at: string }[]> {
    this.checkCalls.push(email);
    return Promise.resolve(this.checkRows.get(email) ?? []);
  }

  studentSignatures(
    instructorId: string,
    query: string,
    limit: number,
  ): Promise<{ name: string | null; signed_at: string | null }[]> {
    this.studentCalls.push({ instructorId, query, limit });
    return Promise.resolve(this.studentRows);
  }
}
