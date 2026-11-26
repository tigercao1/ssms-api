import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import {
  ADMIN_AUTH,
  ADMIN_USER_ID,
  INSTRUCTOR_AUTH,
  InMemoryPrivateStorage,
  startDocumentsApp,
} from '../../test/helpers/documents-fakes';
import { recordingAudit } from '../../test/helpers/public-pages-fakes';
import { AuditService } from '../audit/audit.service';
import { AdminJotformImportsController } from './admin-jotform-imports.controller';
import { JotformImportsRepository } from './jotform-imports.repository';
import {
  JOTFORM_PDF_INVALID,
  JOTFORM_PDF_REQUIRED,
  JOTFORM_WAIVER_MISSING,
  JotformImportsService,
} from './jotform-imports.service';
import type {
  ImportedSignatureRow,
  JotformImportResult,
  NewImportedSignature,
} from './jotform-imports.types';
import { PrivateStorageClient } from './private-storage.client';
import { sha256Hex } from './template-pdf';

const WAIVER_ID = '33333333-3333-4333-8333-333333333301';
const PDF = Buffer.from('%PDF-1.4\nJotform signed copy\n%%EOF\n', 'latin1');

class InMemoryJotformImportsRepository extends JotformImportsRepository {
  readonly rows: NewImportedSignature[] = [];
  readonly customers = new Map<string, string>();
  readonly customerCalls: [string, string | null, string | null][] = [];
  waiverId: string | null = WAIVER_ID;
  insertError: Error | null = null;
  raceOnInsert = false;

  findImported(submissionId: string): Promise<ImportedSignatureRow | null> {
    const row = this.rows.find((r) => r.external_id === submissionId);
    return Promise.resolve(
      row
        ? {
            id: row.id,
            subject_id: row.subject_id,
            signed_sha256: row.signed_sha256,
          }
        : null,
    );
  }

  formTemplateId(slug: string): Promise<string | null> {
    return Promise.resolve(slug === 'waiver' ? this.waiverId : null);
  }

  customerForEmail(
    email: string,
    firstName: string | null,
    lastName: string | null,
  ): Promise<string> {
    this.customerCalls.push([email, firstName, lastName]);
    const id =
      this.customers.get(email) ??
      `77777777-7777-4777-8777-${String(this.customers.size).padStart(12, '0')}`;
    this.customers.set(email, id);
    return Promise.resolve(id);
  }

  insertImported(row: NewImportedSignature): Promise<boolean> {
    if (this.insertError) {
      return Promise.reject(this.insertError);
    }
    if (this.raceOnInsert) {
      this.rows.push({
        ...row,
        id: 'raced-assignment',
        signed_sha256: 'f'.repeat(64),
      });
      return Promise.resolve(false);
    }
    if (this.rows.some((r) => r.external_id === row.external_id)) {
      return Promise.resolve(false);
    }
    this.rows.push(row);
    return Promise.resolve(true);
  }
}

describe('POST /admin/signatures/jotform', () => {
  let app: INestApplication<App>;
  let repo: InMemoryJotformImportsRepository;
  let storage: InMemoryPrivateStorage;
  let audit: ReturnType<typeof recordingAudit>;

  beforeEach(async () => {
    repo = new InMemoryJotformImportsRepository();
    storage = new InMemoryPrivateStorage();
    audit = recordingAudit();
    app = await startDocumentsApp(
      Test.createTestingModule({
        controllers: [AdminJotformImportsController],
        providers: [
          JotformImportsService,
          { provide: JotformImportsRepository, useValue: repo },
          { provide: PrivateStorageClient, useValue: storage },
          { provide: AuditService, useValue: audit },
        ],
      }),
    );
  });

  afterEach(() => app.close());

  const fields = {
    submissionId: '6693587400114977419',
    formId: '242658653833264',
    submittedAt: '2026-11-01T11:12:20-05:00',
    email: '  Mia.Chen@Example.com ',
    participantName: 'Mia Chen',
    ip: '209.171.1.2',
    typedDate: '11/01/2026',
    guardianName: 'Li Chen',
    witnessName: '',
  };

  const send = (
    overrides: Partial<Record<keyof typeof fields, string>> = {},
    pdf: Buffer | null = PDF,
    auth = ADMIN_AUTH,
  ) => {
    let req = request(app.getHttpServer())
      .post('/admin/signatures/jotform')
      .set('authorization', auth);
    for (const [name, value] of Object.entries({ ...fields, ...overrides })) {
      req = req.field(name, value);
    }
    return pdf ? req.attach('pdf', pdf, 'submission.pdf') : req;
  };

  it('files the submission as a completed waiver signature with Jotform’s PDF unchanged', async () => {
    const res = await send().expect(200);

    const result = res.body as JotformImportResult;
    const [row] = repo.rows;
    expect(result).toEqual({
      status: 'imported',
      submissionId: '6693587400114977419',
      customerId: row.subject_id,
      assignmentId: row.id,
      signedSha256: sha256Hex(PDF),
    });
    expect(repo.customerCalls).toEqual([
      ['mia.chen@example.com', 'Mia', 'Chen'],
    ]);
    expect(row).toEqual({
      id: result.assignmentId,
      template_id: WAIVER_ID,
      subject_id: result.customerId,
      language: 'zh',
      signer_name: 'Mia Chen',
      signer_email: 'mia.chen@example.com',
      signer_ip: '209.171.1.2',
      completed_at: '2026-11-01T16:12:20.000Z',
      signed_key: `subjects/customer/${result.customerId}/documents/${result.assignmentId}.pdf`,
      signed_sha256: sha256Hex(PDF),
      field_values: {
        participantName: 'Mia Chen',
        email: 'mia.chen@example.com',
        date: '11/01/2026',
        guardianName: 'Li Chen',
      },
      external_id: '6693587400114977419',
      external_form_id: '242658653833264',
    });
    expect(storage.objects.get(row.signed_key)).toEqual({
      body: PDF,
      contentType: 'application/pdf',
    });
    expect(audit.entries).toEqual([
      expect.objectContaining({
        action: 'document_assignment.import',
        actor: expect.objectContaining({
          userId: ADMIN_USER_ID,
          role: 'admin',
        }) as unknown,
        targetId: result.assignmentId,
      }),
    ]);
  });

  it('records an English submission in English', async () => {
    await send({
      formId: '232628492941059',
      submissionId: '6638415864517873408',
    }).expect(200);

    expect(repo.rows.map((r) => r.language)).toEqual(['en']);
  });

  it('returns the existing signature when a submission is sent again, without storing another copy', async () => {
    const first = (await send().expect(200)).body as JotformImportResult;

    const again = await send({}, Buffer.from('%PDF-1.4 regenerated')).expect(
      200,
    );

    expect(again.body).toEqual({ ...first, status: 'existing' });
    expect(repo.rows).toHaveLength(1);
    expect(storage.objects.size).toBe(1);
    expect(audit.entries).toHaveLength(1);
  });

  it('files each submission from one email under the same customer', async () => {
    await send().expect(200);
    await send({
      submissionId: '6693587400114977420',
      participantName: 'Leo Chen',
    }).expect(200);

    expect(repo.rows).toHaveLength(2);
    expect(new Set(repo.rows.map((r) => r.subject_id)).size).toBe(1);
  });

  it('removes its stored copy and returns the winner when another import of the submission lands first', async () => {
    repo.raceOnInsert = true;

    const res = await send().expect(200);

    expect(res.body).toEqual(
      expect.objectContaining({
        status: 'existing',
        assignmentId: 'raced-assignment',
      }),
    );
    expect(storage.objects.size).toBe(0);
    expect(audit.entries).toHaveLength(0);
  });

  it('removes its stored copy when the row cannot be written', async () => {
    repo.insertError = new Error('database down');

    await send().expect(500);

    expect(storage.objects.size).toBe(0);
    expect(storage.deleted).toHaveLength(1);
  });

  it('refuses a request without a PDF, or with a file that is not one', async () => {
    const missing = await send({}, null).expect(400);
    const notPdf = await send({}, Buffer.from('<html>login</html>')).expect(
      400,
    );

    expect((missing.body as { message: string }).message).toBe(
      JOTFORM_PDF_REQUIRED,
    );
    expect((notPdf.body as { message: string }).message).toBe(
      JOTFORM_PDF_INVALID,
    );
    expect(repo.rows).toHaveLength(0);
  });

  it.each([
    ['an unknown form', { formId: '999' }],
    ['a submit time without an offset', { submittedAt: '2026-11-01 11:12:20' }],
    ['a submission id that is not numeric', { submissionId: 'abc' }],
    ['an email that is not one', { email: 'nobody' }],
    ['a blank participant name', { participantName: '  ' }],
  ])('refuses %s', async (_label, overrides) => {
    await send(overrides).expect(400);

    expect(repo.rows).toHaveLength(0);
    expect(storage.objects.size).toBe(0);
  });

  it('fails when the waiver form does not exist', async () => {
    repo.waiverId = null;

    const res = await send().expect(404);

    expect((res.body as { message: string }).message).toBe(
      JOTFORM_WAIVER_MISSING,
    );
    expect(storage.objects.size).toBe(0);
  });

  it('is admin only', async () => {
    await send({}, PDF, INSTRUCTOR_AUTH).expect(403);

    expect(repo.rows).toHaveLength(0);
  });
});
