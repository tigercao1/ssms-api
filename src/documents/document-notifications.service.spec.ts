import { createHash } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import {
  InMemoryDocumentAssignmentsRepository,
  InMemoryDocumentSubjectsRepository,
  InMemoryDocumentTemplatesRepository,
} from '../../test/helpers/documents-fakes';
import {
  FAKE_PORTAL_URL,
  RecordingMailer,
} from '../../test/helpers/mailer-fakes';
import { MailerConfig } from '../mailer/mailer.config';
import { MailerService } from '../mailer/mailer.service';
import { ResendEmailSender } from '../mailer/resend-email-sender';
import { EmailRenderer } from '../mailer/templates/email-renderer';
import {
  DocumentNotificationsService,
  signedCopyFilename,
} from './document-notifications.service';

const SHA = 'f'.repeat(64);
const PDF = Buffer.from('%PDF-1.7 signed bytes');

function setup() {
  const mailer = new RecordingMailer();
  const subjects = new InMemoryDocumentSubjectsRepository();
  const templates = new InMemoryDocumentTemplatesRepository();
  const assignments = new InMemoryDocumentAssignmentsRepository(templates);
  const service = new DocumentNotificationsService(
    mailer.asService(),
    subjects,
  );
  const template = templates.seed({
    title_en: 'Instructor agreement',
    title_zh: '教练协议',
  });
  return { mailer, subjects, templates, assignments, service, template };
}

describe('DocumentNotificationsService', () => {
  it('sendAssigned lists the templates in the instructor language with an onboarding link', async () => {
    const { mailer, subjects, templates, service, template } = setup();
    const other = templates.seed({ title_en: 'Safety policy' });
    const instructor = subjects.seedInstructor({
      preferred_language: 'zh-CN',
      display_name_en: 'Lin',
    });

    await expect(
      service.sendAssigned(instructor, [template, other], '2026/27'),
    ).resolves.toBe('sent');
    expect(mailer.sent).toEqual([
      {
        template: 'documents.assigned',
        to: instructor.email,
        language: 'zh-CN',
        vars: {
          displayName: 'Lin',
          documents: [
            { titleEn: 'Instructor agreement', titleZh: '教练协议' },
            { titleEn: 'Safety policy', titleZh: null },
          ],
          onboardingUrl: `${FAKE_PORTAL_URL}/onboarding`,
          approved: false,
        },
        mode: 'background',
        instructorId: instructor.id,
        authUserId: instructor.auth_user_id,
        metadata: {
          templateIds: [template.id, other.id],
          season: '2026/27',
          approved: false,
        },
      },
    ]);
    await expect(service.sendAssigned(instructor, [], null)).resolves.toBe(
      null,
    );
    expect(mailer.sent).toHaveLength(1);
  });

  it('sendAssigned marks the approval email', async () => {
    const { mailer, subjects, service, template } = setup();
    const instructor = subjects.seedInstructor();
    await service.sendAssigned(instructor, [template], '2026/27', {
      approved: true,
    });
    expect(mailer.sent[0]).toMatchObject({
      template: 'documents.assigned',
      vars: { approved: true },
      metadata: { approved: true },
    });
  });

  it('sendAssigned falls back to bilingual without a supported language', async () => {
    const { mailer, subjects, service, template } = setup();
    const instructor = subjects.seedInstructor({ preferred_language: null });
    await service.sendAssigned(instructor, [template], null);
    expect(mailer.sent[0].language).toBe('bilingual');
  });

  it('sendReminder sends one email for all the assignments, with the idempotency key', async () => {
    const { mailer, subjects, assignments, service, template } = setup();
    const instructor = subjects.seedInstructor();
    const row = assignments.seed({
      template_id: template.id,
      subject_id: instructor.id,
    });
    const orphan = assignments.seed({
      template_id: 'gone',
      subject_id: instructor.id,
    });

    await service.sendReminder(instructor, [row, orphan], 'key-1');
    expect(mailer.sentOf('documents.reminder')).toEqual([
      expect.objectContaining({
        to: instructor.email,
        language: 'en',
        idempotencyKey: 'key-1',
        metadata: { assignmentIds: [row.id, orphan.id] },
        vars: expect.objectContaining({
          documents: [{ titleEn: 'Instructor agreement', titleZh: '教练协议' }],
        }) as unknown,
      }),
    ]);
    await service.sendReminder(instructor, [row]);
    expect(mailer.sent[1]).not.toHaveProperty('idempotencyKey');
    await expect(service.sendReminder(instructor, [orphan])).resolves.toBe(
      null,
    );
    expect(mailer.sent).toHaveLength(2);
  });

  describe('sendCompleted', () => {
    it('emails an instructor the signed PDF, the SHA-256 and a portal link', async () => {
      const { mailer, subjects, assignments, service, template } = setup();
      const instructor = subjects.seedInstructor({
        preferred_language: 'zh-CN',
      });
      const row = assignments.seed({
        template_id: template.id,
        subject_id: instructor.id,
        status: 'completed',
        signer_name: 'Lin Wei',
        signer_email: 'signer@example.com',
      });

      await expect(
        service.sendCompleted(row, template, PDF, SHA),
      ).resolves.toBe('sent');
      expect(mailer.sent).toEqual([
        {
          template: 'documents.completed',
          to: 'signer@example.com',
          language: 'zh-CN',
          vars: {
            displayName: 'Lin Wei',
            document: { titleEn: 'Instructor agreement', titleZh: '教练协议' },
            sha256: SHA,
            onboardingUrl: `${FAKE_PORTAL_URL}/onboarding`,
          },
          mode: 'background',
          instructorId: instructor.id,
          authUserId: instructor.auth_user_id,
          metadata: {
            assignmentId: row.id,
            templateId: template.id,
            subjectType: 'instructor',
            subjectId: instructor.id,
            signedSha256: SHA,
          },
          idempotencyKey: `documents.completed/${row.id}`,
          attachments: [
            {
              filename: 'Instructor-agreement-signed.pdf',
              content: PDF,
              contentType: 'application/pdf',
            },
          ],
        },
      ]);
    });

    it("falls back to the instructor's account email and display name", async () => {
      const { mailer, subjects, assignments, service, template } = setup();
      const instructor = subjects.seedInstructor({ display_name_en: 'Eddie' });
      const row = assignments.seed({
        template_id: template.id,
        subject_id: instructor.id,
        signer_email: '  ',
      });
      await service.sendCompleted(row, template, PDF, SHA);
      expect(mailer.sent[0]).toMatchObject({
        to: instructor.email,
        vars: { displayName: 'Eddie' },
      });
    });

    it('emails a customer bilingually without a portal link, and skips one without an email', async () => {
      const { mailer, assignments, service, template } = setup();
      const customer = assignments.seed({
        template_id: template.id,
        subject_id: 'c1',
        subject_type: 'customer',
        signer_email: 'guest@example.com',
      });
      await service.sendCompleted(customer, template, PDF, SHA);
      expect(mailer.sent[0]).toMatchObject({
        to: 'guest@example.com',
        language: 'bilingual',
        instructorId: null,
        authUserId: null,
        vars: { onboardingUrl: null, displayName: undefined },
      });

      const anonymous = assignments.seed({
        template_id: template.id,
        subject_id: 'c2',
        subject_type: 'customer',
      });
      await expect(
        service.sendCompleted(anonymous, template, PDF, SHA),
      ).resolves.toBeNull();
      expect(mailer.sent).toHaveLength(1);
    });

    it('skips an instructor assignment with no instructor and no signer email', async () => {
      const { mailer, assignments, service, template } = setup();
      const row = assignments.seed({
        template_id: template.id,
        subject_id: 'missing',
      });
      await expect(
        service.sendCompleted(row, template, PDF, SHA),
      ).resolves.toBeNull();
      expect(mailer.sent).toHaveLength(0);
    });

    it('reaches Resend with the PDF base64-attached and logs it in email_log', async () => {
      const { subjects, assignments, template } = setup();
      const instructor = subjects.seedInstructor();
      const row = assignments.seed({
        template_id: template.id,
        subject_id: instructor.id,
      });
      const env: Record<string, string> = {
        RESEND_API_KEY: 're_test',
        MAIL_FROM: 'Snow <noreply@example.com>',
        PORTAL_URL: 'https://app.example.com',
      };
      const config = { get: (k: string) => env[k] } as unknown as ConfigService;
      const inserts: Record<string, unknown>[] = [];
      const supabase = {
        from: () => ({
          insert: (r: Record<string, unknown>) => {
            inserts.push(r);
            return Promise.resolve({ error: null });
          },
        }),
      };
      const mailerConfig = new MailerConfig(config);
      const mailer = new MailerService(
        new ResendEmailSender(config),
        new EmailRenderer(mailerConfig),
        mailerConfig,
        supabase as never,
      );
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: () => Promise.resolve({ id: 'resend-1' }),
      });
      const originalFetch = global.fetch;
      global.fetch = fetchMock;
      try {
        await expect(
          new DocumentNotificationsService(mailer, subjects).sendCompleted(
            row,
            template,
            PDF,
            SHA,
          ),
        ).resolves.toBe('sent');
      } finally {
        global.fetch = originalFetch;
      }

      const [, init] = fetchMock.mock.calls[0] as [
        string,
        { body: string; headers: Record<string, string> },
      ];
      const body = JSON.parse(init.body) as {
        attachments: unknown[];
        html: string;
        text: string;
      };
      expect(init.headers['Idempotency-Key']).toBe(
        `documents.completed/${row.id}`,
      );
      expect(body.attachments).toEqual([
        {
          filename: 'Instructor-agreement-signed.pdf',
          content: PDF.toString('base64'),
          content_type: 'application/pdf',
        },
      ]);
      expect(body.html).toContain(SHA);
      expect(body.text).toContain('https://app.example.com/onboarding');
      expect(inserts[0]).toMatchObject({
        template: 'documents.completed',
        status: 'sent',
        provider_id: 'resend-1',
        metadata: {
          assignmentId: row.id,
          signedSha256: SHA,
          attachments: [
            {
              filename: 'Instructor-agreement-signed.pdf',
              contentType: 'application/pdf',
              sizeBytes: PDF.length,
              sha256: createHash('sha256').update(PDF).digest('hex'),
            },
          ],
        },
      });
    });
  });

  it.each([
    ['Instructor agreement', 'Instructor-agreement-signed.pdf'],
    ['  Café / Waiver (2026)  ', 'Cafe-Waiver-2026-signed.pdf'],
    ['教练协议', 'document-signed.pdf'],
    ['a'.repeat(100), `${'a'.repeat(80)}-signed.pdf`],
  ])('names the attachment for %j as %s', (title, filename) => {
    expect(
      signedCopyFilename({ id: 't', title_en: title, title_zh: null }),
    ).toBe(filename);
  });
});
