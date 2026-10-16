import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import {
  INSTRUCTOR_AUTH,
  INSTRUCTOR_USER_ID,
  InMemoryDocumentAssignmentsRepository,
  InMemoryDocumentSubjectsRepository,
  InMemoryDocumentTemplatesRepository,
  InMemoryPrivateStorage,
  startDocumentsApp,
} from '../../test/helpers/documents-fakes';
import { seasonsProviders } from '../../test/helpers/seasons-fakes';
import { pdfFixture } from '../../test/helpers/pdf-fixtures';
import { signaturePng } from '../../test/helpers/png-fixtures';
import { recordingAudit } from '../../test/helpers/public-pages-fakes';
import { AuditService } from '../audit/audit.service';
import { MailerConfig } from '../mailer/mailer.config';
import { MailerService } from '../mailer/mailer.service';
import { ResendEmailSender } from '../mailer/resend-email-sender';
import { EmailRenderer } from '../mailer/templates/email-renderer';
import { DocumentAssignmentsRepository } from './document-assignments.repository';
import { DocumentCompletedEmailHandler } from './document-completed-email.handler';
import { DocumentCompletedHandler } from './document-completed.handler';
import { DocumentNotificationsService } from './document-notifications.service';
import { DocumentSigningService } from './document-signing.service';
import { DocumentSubjectsRepository } from './document-subjects.repository';
import { DocumentTemplatesRepository } from './document-templates.repository';
import { MeDocumentsController } from './me-documents.controller';
import { MeDocumentsService } from './me-documents.service';
import { PdfWorkQueue } from './pdf-work-queue';
import { PrivateStorageClient } from './private-storage.client';
import { signingBodyParser } from './signing-body-parser';
import { storageKeys } from './storage-keys';
import { normaliseTemplatePdf, sha256Hex } from './template-pdf';

jest.setTimeout(30_000);

const ENV: Record<string, string> = {
  RESEND_API_KEY: 're_test',
  MAIL_FROM: 'Snow <noreply@example.com>',
  PORTAL_URL: 'https://app.example.com',
};

interface ResendBody {
  to: string[] | string;
  subject: string;
  html: string;
  text: string;
  attachments: { filename: string; content: string; content_type: string }[];
}

async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 300 && !done(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(done()).toBe(true);
}

async function build() {
  const storage = new InMemoryPrivateStorage();
  const templates = new InMemoryDocumentTemplatesRepository();
  const assignments = new InMemoryDocumentAssignmentsRepository(templates);
  const subjects = new InMemoryDocumentSubjectsRepository();
  const emailLog: Record<string, unknown>[] = [];
  const supabase = {
    from: (table: string) => ({
      insert: (row: Record<string, unknown>) => {
        if (table === 'email_log') {
          emailLog.push(row);
        }
        return Promise.resolve({ error: null });
      },
    }),
  };
  const config = { get: (k: string) => ENV[k] } as unknown as ConfigService;
  const mailerConfig = new MailerConfig(config);
  const mailer = new MailerService(
    new ResendEmailSender(config),
    new EmailRenderer(mailerConfig),
    mailerConfig,
    supabase as never,
  );
  const app = await startDocumentsApp(
    Test.createTestingModule({
      controllers: [MeDocumentsController],
      providers: [
        ...seasonsProviders(),
        DocumentSigningService,
        MeDocumentsService,
        PdfWorkQueue,
        DocumentNotificationsService,
        {
          provide: DocumentCompletedHandler,
          useClass: DocumentCompletedEmailHandler,
        },
        { provide: MailerService, useValue: mailer },
        { provide: PrivateStorageClient, useValue: storage },
        { provide: DocumentTemplatesRepository, useValue: templates },
        { provide: DocumentAssignmentsRepository, useValue: assignments },
        { provide: DocumentSubjectsRepository, useValue: subjects },
        { provide: AuditService, useValue: recordingAudit() },
        { provide: ConfigService, useValue: config },
      ],
    }),
    (app) => app.use(signingBodyParser),
  );
  const instructor = subjects.seedInstructor({
    auth_user_id: INSTRUCTOR_USER_ID,
    email: 'alice@example.com',
    display_name_en: 'Alice Wang',
  });
  const source = await normaliseTemplatePdf(await pdfFixture('normal'));
  storage.seed('templates/t/source.pdf', source.bytes);
  const template = templates.seed({
    kind: 'sign',
    title_en: 'Instructor agreement',
    title_zh: '教练协议',
    source_key: 'templates/t/source.pdf',
    source_sha256: source.sha256,
    page_count: source.pageCount,
    pages: source.pages,
    fields: [
      {
        id: 'sig',
        type: 'signature',
        page: 1,
        x: 72,
        y: 100,
        w: 180,
        h: 50,
        required: true,
        label_en: 'Signature',
        label_zh: null,
        prefill: null,
      },
    ],
  });
  const assignment = assignments.seed({
    template_id: template.id,
    subject_id: instructor.id,
  });
  return {
    app,
    storage,
    assignments,
    subjects,
    emailLog,
    instructor,
    assignment,
  };
}

const SIGN_BODY = {
  consent: true,
  signerName: 'Alice Wang',
  signatures: {
    sig: { mode: 'drawn', png: signaturePng().toString('base64') },
  },
};

describe('signed-copy email on completion', () => {
  let ctx: Awaited<ReturnType<typeof build>>;
  let fetchMock: jest.Mock;
  const originalFetch = global.fetch;
  const complete = () =>
    request(ctx.app.getHttpServer())
      .post(`/me/documents/${ctx.assignment.id}/complete`)
      .set('Authorization', INSTRUCTOR_AUTH)
      .send(SIGN_BODY);

  beforeEach(async () => {
    ctx = await build();
    fetchMock = jest.fn();
    global.fetch = fetchMock;
  });

  afterEach(async () => {
    global.fetch = originalFetch;
    await ctx.app.close();
  });

  it('emails documents.completed with the signed PDF attached and its SHA-256 in the body', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: () => Promise.resolve({ id: 'resend-1' }),
    });

    await complete().expect(200);
    await until(() => ctx.emailLog.length > 0);

    const key = storageKeys.instructorDocument(
      ctx.instructor.id,
      ctx.assignment.id,
    );
    const stored = ctx.storage.objects.get(key)!.body;
    const sha256 = sha256Hex(stored);
    expect(ctx.assignments.rows.get(ctx.assignment.id)?.signed_sha256).toBe(
      sha256,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [
      string,
      { body: string; headers: Record<string, string> },
    ];
    const body = JSON.parse(init.body) as ResendBody;
    expect(init.headers['Idempotency-Key']).toBe(
      `documents.completed/${ctx.assignment.id}`,
    );
    expect(body.to).toEqual(
      expect.arrayContaining(['alice@example.com']) as unknown,
    );
    expect(body.subject).toContain('Instructor agreement');
    expect(body.attachments).toEqual([
      {
        filename: 'Instructor-agreement-signed.pdf',
        content: Buffer.from(stored).toString('base64'),
        content_type: 'application/pdf',
      },
    ]);
    expect(body.html).toContain(sha256);
    expect(body.text).toContain(sha256);
    expect(ctx.emailLog[0]).toMatchObject({
      template: 'documents.completed',
      status: 'sent',
      recipient: 'alice@example.com',
      metadata: { assignmentId: ctx.assignment.id, signedSha256: sha256 },
    });
  });

  it('keeps the completion when Resend fails', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Server Error',
      json: () => Promise.resolve({ message: 'down' }),
      text: () => Promise.resolve('down'),
    });

    const res = await complete().expect(200);
    expect(res.body).toMatchObject({
      assignment: { status: 'completed', hasSignedCopy: true },
    });
    await until(() => ctx.emailLog.length > 0);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(ctx.emailLog[0]).toMatchObject({
      template: 'documents.completed',
      status: 'failed',
    });
    expect(ctx.assignments.rows.get(ctx.assignment.id)).toMatchObject({
      status: 'completed',
      signed_key: storageKeys.instructorDocument(
        ctx.instructor.id,
        ctx.assignment.id,
      ),
    });
  });

  it('keeps the completion when the recipient lookup throws', async () => {
    const lookup = jest
      .spyOn(ctx.subjects, 'findInstructor')
      .mockRejectedValue(new Error('db down'));

    await complete().expect(200);
    await until(() => lookup.mock.calls.length > 0);
    await new Promise((resolve) => setImmediate(resolve));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(ctx.assignments.rows.get(ctx.assignment.id)?.status).toBe(
      'completed',
    );
    await request(ctx.app.getHttpServer())
      .post(`/me/documents/${ctx.assignment.id}/complete`)
      .set('Authorization', INSTRUCTOR_AUTH)
      .send(SIGN_BODY)
      .expect(409);
  });
});
