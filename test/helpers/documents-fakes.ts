import { randomUUID } from 'node:crypto';
import {
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import type { TestingModuleBuilder } from '@nestjs/testing';
import type { Request } from 'express';
import type { App } from 'supertest/types';
import { SupabaseAuthGuard } from '../../src/auth/supabase-auth.guard';
import {
  DatabaseError,
  PG_UNIQUE_VIOLATION,
} from '../../src/database/db-result';
import { DocumentAssignmentsRepository } from '../../src/documents/document-assignments.repository';
import type { DocumentAssignmentWrite } from '../../src/documents/document-assignments.repository';
import { DocumentSubjectsRepository } from '../../src/documents/document-subjects.repository';
import {
  DocumentTemplatesRepository,
  type NewDocumentTemplate,
} from '../../src/documents/document-templates.repository';
import type {
  AssignmentStatus,
  CertificationUploadRow,
  DocumentAssignmentRow,
  DocumentInstructorRow,
  DocumentTemplateRow,
  DocumentTemplateWrite,
  InstructorCertificationRow,
  NewAssignmentRow,
  SubjectType,
  TemplateAssignmentStats,
  TemplateStatus,
} from '../../src/documents/documents.types';
import {
  ObjectTooLargeError,
  PrivateStorageClient,
  type PresignedUrl,
  type StoredObjectHead,
} from '../../src/documents/private-storage.client';
import { Readable } from 'node:stream';

export const ADMIN_USER_ID = '7d0f8a1e-5b2c-4e3d-9a8b-1c2d3e4f5a6b';
export const INSTRUCTOR_USER_ID = '2b3c4d5e-6f70-4a81-9b2c-3d4e5f607182';
export const ADMIN_AUTH = 'Bearer jwt-admin';
/** Verified-email instructor whose `auth_user_id` is {@link INSTRUCTOR_USER_ID}. */
export const INSTRUCTOR_AUTH = 'Bearer jwt-instructor';
export const UNVERIFIED_AUTH = 'Bearer jwt-unverified';

class FakeDocumentsJwtGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const who = /^Bearer jwt-(\w+)$/.exec(req.headers.authorization ?? '')?.[1];
    if (!who) {
      throw new UnauthorizedException();
    }
    (req as Request & { user: unknown }).user = {
      sub: who === 'admin' ? ADMIN_USER_ID : INSTRUCTOR_USER_ID,
      email: `${who}@example.com`,
      email_confirmed_at: who === 'unverified' ? null : '2026-01-01T00:00:00Z',
      app_metadata: who === 'admin' ? { role: 'admin' } : {},
    };
    return true;
  }
}

/**
 * Boots a test app with a fake JWT guard (admin, verified instructor or
 * unverified user, picked by the bearer token) and the real role and
 * email-verified guards.
 */
export async function startDocumentsApp(
  builder: TestingModuleBuilder,
  configure?: (app: INestApplication<App>) => void,
): Promise<INestApplication<App>> {
  const moduleRef = await builder
    .overrideGuard(SupabaseAuthGuard)
    .useClass(FakeDocumentsJwtGuard)
    .compile();
  const app = moduleRef.createNestApplication<INestApplication<App>>();
  configure?.(app);
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  await app.listen(0, '127.0.0.1');
  return app;
}

/** In-memory private bucket. Presigned URLs are `memory://<op>/<key>`. */
export class InMemoryPrivateStorage extends PrivateStorageClient {
  readonly objects = new Map<string, { body: Buffer; contentType: string }>();
  readonly presigned: { op: 'PUT' | 'GET'; key: string; input: unknown }[] = [];
  readonly deleted: string[] = [];

  seed(key: string, body: Uint8Array, contentType = 'application/pdf'): void {
    this.objects.set(key, { body: Buffer.from(body), contentType });
  }

  presignPut(
    key: string,
    input: { contentType: string; contentLength: number },
  ): Promise<PresignedUrl> {
    this.presigned.push({ op: 'PUT', key, input });
    return Promise.resolve({
      url: `memory://PUT/${key}`,
      expiresAt: '2026-10-13T00:10:00.000Z',
    });
  }

  presignGet(key: string, input?: unknown): Promise<PresignedUrl> {
    this.presigned.push({ op: 'GET', key, input });
    return Promise.resolve({
      url: `memory://GET/${key}`,
      expiresAt: '2026-10-13T00:05:00.000Z',
    });
  }

  head(key: string): Promise<StoredObjectHead | null> {
    const object = this.objects.get(key);
    return Promise.resolve(
      object
        ? { contentLength: object.body.length, contentType: object.contentType }
        : null,
    );
  }

  async getStream(key: string, maxBytes: number): Promise<Readable | null> {
    const body = await this.getBuffer(key, maxBytes);
    return body ? Readable.from([body]) : null;
  }

  getBuffer(key: string, maxBytes: number): Promise<Buffer | null> {
    const object = this.objects.get(key);
    if (object && object.body.length > maxBytes) {
      return Promise.reject(new ObjectTooLargeError(key, maxBytes));
    }
    return Promise.resolve(object?.body ?? null);
  }

  put(key: string, body: Uint8Array, contentType: string): Promise<void> {
    this.seed(key, body, contentType);
    return Promise.resolve();
  }

  delete(key: string): Promise<void> {
    this.deleted.push(key);
    this.objects.delete(key);
    return Promise.resolve();
  }
}

let clock = Date.parse('2026-10-01T00:00:00Z');
function nextTimestamp(): string {
  clock += 1000;
  return new Date(clock).toISOString();
}

/** A `document_templates` row with sensible defaults. */
export function templateRow(
  overrides: Partial<DocumentTemplateRow> = {},
): DocumentTemplateRow {
  const now = nextTimestamp();
  return {
    id: randomUUID(),
    kind: 'sign',
    audience: 'instructor',
    title_en: 'Instructor agreement',
    title_zh: null,
    description_en: null,
    description_zh: null,
    required: true,
    status: 'live',
    assign_to: 'selected',
    season: '2026-27',
    published_at: null,
    published_by: null,
    sort_order: 0,
    source_key: null,
    source_sha256: null,
    page_count: null,
    pages: [],
    fields: [],
    updated_by: null,
    inserted_at: now,
    updated_at: now,
    ...overrides,
  };
}

export class InMemoryDocumentTemplatesRepository extends DocumentTemplatesRepository {
  readonly rows = new Map<string, DocumentTemplateRow>();

  seed(overrides: Partial<DocumentTemplateRow> = {}): DocumentTemplateRow {
    const row = templateRow(overrides);
    this.rows.set(row.id, row);
    return row;
  }

  list(): Promise<DocumentTemplateRow[]> {
    return Promise.resolve(
      [...this.rows.values()].sort(
        (a, b) =>
          a.sort_order - b.sort_order || a.title_en.localeCompare(b.title_en),
      ),
    );
  }

  findById(id: string): Promise<DocumentTemplateRow | null> {
    return Promise.resolve(this.rows.get(id) ?? null);
  }

  async listLiveForAll(
    audience: DocumentTemplateRow['audience'],
    season?: string | null,
  ): Promise<DocumentTemplateRow[]> {
    return (await this.list()).filter(
      (t) =>
        t.audience === audience &&
        t.status === 'live' &&
        t.assign_to === 'all' &&
        (!season || t.season === season),
    );
  }

  insert(input: NewDocumentTemplate): Promise<DocumentTemplateRow> {
    return Promise.resolve(
      this.seed({ status: 'draft', assign_to: null, season: null, ...input }),
    );
  }

  update(
    id: string,
    patch: DocumentTemplateWrite,
  ): Promise<DocumentTemplateRow | null> {
    const row = this.rows.get(id);
    if (!row) {
      return Promise.resolve(null);
    }
    const next = { ...row, ...patch, updated_at: nextTimestamp() };
    this.rows.set(id, next);
    return Promise.resolve(next);
  }

  updateIfStatus(
    id: string,
    statuses: TemplateStatus[],
    patch: DocumentTemplateWrite,
  ): Promise<DocumentTemplateRow | null> {
    const row = this.rows.get(id);
    return row && statuses.includes(row.status)
      ? this.update(id, patch)
      : Promise.resolve(null);
  }
}

/**
 * In-memory assignments enforcing the open-assignment unique index
 * (template, subject, season) where status is not archived.
 */
export class InMemoryDocumentAssignmentsRepository extends DocumentAssignmentsRepository {
  readonly rows = new Map<string, Omit<DocumentAssignmentRow, 'template'>>();
  readonly reminderClaims = new Map<string, string>();
  insertManyCalls = 0;

  constructor(
    private readonly templates: InMemoryDocumentTemplatesRepository,
    private readonly subjects?: InMemoryDocumentSubjectsRepository,
  ) {
    super();
  }

  seed(
    overrides: Partial<Omit<DocumentAssignmentRow, 'template'>> &
      Pick<DocumentAssignmentRow, 'template_id' | 'subject_id'>,
  ): DocumentAssignmentRow {
    const now = nextTimestamp();
    const row = {
      id: randomUUID(),
      subject_type: 'instructor' as SubjectType,
      season: '2026-27',
      class_id: null,
      status: 'assigned' as const,
      assigned_at: now,
      viewed_at: null,
      completed_at: null,
      due_at: null,
      reminder_sent_at: null,
      signer_name: null,
      signer_email: null,
      signer_ip: null,
      signer_user_agent: null,
      consent_at: null,
      template_sha256: null,
      signed_key: null,
      signed_sha256: null,
      field_values: {},
      inserted_at: now,
      updated_at: now,
      ...overrides,
    };
    this.rows.set(row.id, row);
    return this.withTemplate(row);
  }

  private withTemplate(
    row: Omit<DocumentAssignmentRow, 'template'>,
  ): DocumentAssignmentRow {
    const t = this.templates.rows.get(row.template_id);
    return {
      ...row,
      template: t
        ? {
            id: t.id,
            kind: t.kind,
            audience: t.audience,
            title_en: t.title_en,
            title_zh: t.title_zh,
            description_en: t.description_en,
            description_zh: t.description_zh,
            required: t.required,
            status: t.status,
            sort_order: t.sort_order,
          }
        : null,
    };
  }

  private conflicts(row: NewAssignmentRow): boolean {
    return [...this.rows.values()].some(
      (r) =>
        r.status !== 'archived' &&
        r.template_id === row.template_id &&
        r.subject_type === row.subject_type &&
        r.subject_id === row.subject_id &&
        (r.season ?? '') === (row.season ?? ''),
    );
  }

  listForSubject(
    subjectType: SubjectType,
    subjectId: string,
  ): Promise<DocumentAssignmentRow[]> {
    return Promise.resolve(
      [...this.rows.values()]
        .filter(
          (r) => r.subject_type === subjectType && r.subject_id === subjectId,
        )
        .sort((a, b) => b.assigned_at.localeCompare(a.assigned_at))
        .map((r) => this.withTemplate(r)),
    );
  }

  findById(id: string): Promise<DocumentAssignmentRow | null> {
    const row = this.rows.get(id);
    return Promise.resolve(row ? this.withTemplate(row) : null);
  }

  findOpenSubjectIds(
    templateId: string,
    season: string,
    subjectType: SubjectType,
    subjectIds: string[],
  ): Promise<Set<string>> {
    return Promise.resolve(
      new Set(
        subjectIds.filter((subjectId) =>
          this.conflicts({
            template_id: templateId,
            subject_type: subjectType,
            subject_id: subjectId,
            season,
          }),
        ),
      ),
    );
  }

  insertMany(rows: NewAssignmentRow[]): Promise<number> {
    this.insertManyCalls += 1;
    if (rows.some((row) => this.conflicts(row))) {
      return Promise.reject(
        new DatabaseError(
          'create document assignments',
          PG_UNIQUE_VIOLATION,
          'duplicate key value violates unique constraint "document_assignments_open_key"',
        ),
      );
    }
    for (const row of rows) {
      this.seed(row);
    }
    return Promise.resolve(rows.length);
  }

  insertIfAbsent(row: NewAssignmentRow): Promise<boolean> {
    if (this.conflicts(row)) {
      return Promise.resolve(false);
    }
    this.seed(row);
    return Promise.resolve(true);
  }

  update(
    id: string,
    patch: DocumentAssignmentWrite,
  ): Promise<DocumentAssignmentRow | null> {
    const row = this.rows.get(id);
    if (!row) {
      return Promise.resolve(null);
    }
    const next = { ...row, ...patch, updated_at: nextTimestamp() };
    this.rows.set(id, next);
    return Promise.resolve(this.withTemplate(next));
  }

  updateIfStatus(
    id: string,
    statuses: AssignmentStatus[],
    patch: DocumentAssignmentWrite,
  ): Promise<DocumentAssignmentRow | null> {
    const row = this.rows.get(id);
    return row && statuses.includes(row.status)
      ? this.update(id, patch)
      : Promise.resolve(null);
  }

  hasCompleted(templateId: string): Promise<boolean> {
    return Promise.resolve(
      [...this.rows.values()].some(
        (r) => r.template_id === templateId && r.status === 'completed',
      ),
    );
  }

  templateStatsCalls: string[][] = [];

  templateStats(
    templateIds: string[],
  ): Promise<Map<string, TemplateAssignmentStats>> {
    this.templateStatsCalls.push(templateIds);
    const stats = new Map<string, TemplateAssignmentStats>();
    for (const id of templateIds) {
      const template = this.templates.rows.get(id);
      if (!template) {
        continue;
      }
      const open = [...this.rows.values()].filter(
        (r) => r.template_id === id && r.status !== 'archived',
      );
      const inSeason = open.filter((r) => r.season === template.season);
      const approved = inSeason.filter((r) => {
        const instructor = this.subjects?.instructors.get(r.subject_id);
        return (
          r.subject_type === 'instructor' &&
          instructor?.approval_status === 'approved' &&
          instructor.is_active
        );
      });
      stats.set(id, {
        assignedCount: inSeason.length,
        completedCount: inSeason.filter((r) => r.status === 'completed').length,
        approvedAssignedCount: approved.length,
        approvedCompletedCount: approved.filter((r) => r.status === 'completed')
          .length,
        hasCompleted: open.some((r) => r.status === 'completed'),
      });
    }
    return Promise.resolve(stats);
  }

  listDueForReminder(
    subjectType: SubjectType,
    cutoff: Date,
  ): Promise<DocumentAssignmentRow[]> {
    const at = cutoff.toISOString();
    return Promise.resolve(
      [...this.rows.values()]
        .filter(
          (r) =>
            r.subject_type === subjectType &&
            (r.status === 'assigned' || r.status === 'viewed') &&
            r.assigned_at < at &&
            (r.reminder_sent_at === null || r.reminder_sent_at < at),
        )
        .sort((a, b) => a.assigned_at.localeCompare(b.assigned_at))
        .map((r) => this.withTemplate(r)),
    );
  }

  claimForReminder(ids: string[], cutoff: Date, at: Date): Promise<string[]> {
    const before = cutoff.toISOString();
    const claimed = ids.filter((id) => {
      const r = this.rows.get(id);
      const claim = this.reminderClaims.get(id);
      return (
        r !== undefined &&
        (r.status === 'assigned' || r.status === 'viewed') &&
        r.assigned_at < before &&
        (r.reminder_sent_at === null || r.reminder_sent_at < before) &&
        (claim === undefined || claim < before)
      );
    });
    for (const id of claimed) {
      this.reminderClaims.set(id, at.toISOString());
    }
    return Promise.resolve(claimed);
  }

  releaseReminderClaim(ids: string[], claimedAt: Date): Promise<void> {
    for (const id of ids) {
      if (this.reminderClaims.get(id) === claimedAt.toISOString()) {
        this.reminderClaims.delete(id);
      }
    }
    return Promise.resolve();
  }
}

/** A certification upload row with sensible defaults. */
export function certificationUploadRow(
  overrides: Partial<CertificationUploadRow> &
    Pick<CertificationUploadRow, 'instructor_id'>,
): CertificationUploadRow {
  const now = nextTimestamp();
  return {
    id: randomUUID(),
    org: 'csia',
    track: 'regular',
    file_key: 'subjects/instructor/x/certifications/y.pdf',
    sha256: 'a'.repeat(64),
    content_type: 'application/pdf',
    size_bytes: 1000,
    review_status: 'approved',
    review_note: null,
    reviewed_by: null,
    reviewed_at: null,
    valid_until: '2027-10-31',
    expiry_reminder_sent_at: null,
    ai_result: null,
    ai_model: null,
    ai_checked_at: null,
    inserted_at: now,
    updated_at: now,
    ...overrides,
  };
}

export class InMemoryDocumentSubjectsRepository extends DocumentSubjectsRepository {
  readonly instructors = new Map<string, DocumentInstructorRow>();
  readonly certifications = new Map<string, InstructorCertificationRow[]>();
  readonly uploads: CertificationUploadRow[] = [];

  seedInstructor(
    overrides: Partial<DocumentInstructorRow> = {},
  ): DocumentInstructorRow {
    const row: DocumentInstructorRow = {
      id: randomUUID(),
      auth_user_id: randomUUID(),
      email: 'eddie@example.com',
      first_name: null,
      last_name: null,
      display_name_en: 'Eddie',
      approval_status: 'approved',
      is_active: true,
      preferred_language: 'en',
      ...overrides,
    };
    this.instructors.set(row.id, row);
    return row;
  }

  findInstructorByAuthUser(
    authUserId: string,
  ): Promise<DocumentInstructorRow | null> {
    return Promise.resolve(
      [...this.instructors.values()].find(
        (i) => i.auth_user_id === authUserId,
      ) ?? null,
    );
  }

  findInstructor(id: string): Promise<DocumentInstructorRow | null> {
    return Promise.resolve(this.instructors.get(id) ?? null);
  }

  listActiveApprovedInstructorIds(): Promise<string[]> {
    return Promise.resolve(
      [...this.instructors.values()]
        .filter((i) => i.approval_status === 'approved' && i.is_active)
        .map((i) => i.id),
    );
  }

  countActiveApprovedInstructors(): Promise<number> {
    return Promise.resolve(
      [...this.instructors.values()].filter(
        (i) => i.approval_status === 'approved' && i.is_active,
      ).length,
    );
  }

  countPendingInstructors(): Promise<number> {
    return Promise.resolve(
      [...this.instructors.values()].filter(
        (i) => i.approval_status === 'pending',
      ).length,
    );
  }

  existingInstructorIds(ids: string[]): Promise<Set<string>> {
    return Promise.resolve(
      new Set(ids.filter((id) => this.instructors.has(id))),
    );
  }

  listCertifications(
    instructorId: string,
  ): Promise<InstructorCertificationRow[]> {
    return Promise.resolve(this.certifications.get(instructorId) ?? []);
  }

  listCertificationUploads(
    instructorId: string,
  ): Promise<CertificationUploadRow[]> {
    return Promise.resolve(
      this.uploads
        .filter((u) => u.instructor_id === instructorId)
        .sort((a, b) => b.inserted_at.localeCompare(a.inserted_at)),
    );
  }
}
