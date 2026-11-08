import { randomUUID } from 'node:crypto';
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
  type FormVersionRow,
  type PublishedForm,
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
  versions: FormVersionRow[];
}

/** A published form version with the default waiver fields. */
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
    published_at: '2026-11-01T00:00:00.000Z',
    published_by: null,
    updated_by: null,
    inserted_at: '2026-11-01T00:00:00.000Z',
    updated_at: '2026-11-01T00:00:00.000Z',
    ...overrides,
  };
}

/**
 * In-memory forms, customers and signed assignments. `customerForEmail`
 * mirrors `waiver_customer_for_email`: the oldest live row with the email,
 * Shopify customers first, else a new row; names are never matched.
 */
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

  seedForm(slug: string, versions: FormVersionRow[] = []): string {
    const templateId = versions[0]?.template_id ?? randomUUID();
    this.forms.push({
      templateId,
      slug,
      titleEn: 'Lesson waiver',
      titleZh: '课程免责声明',
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
