import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import {
  InMemoryDocumentSubjectsRepository,
  InMemoryPrivateStorage,
  startDocumentsApp,
} from '../../test/helpers/documents-fakes';
import {
  formVersion,
  InMemoryFormSigningRepository,
} from '../../test/helpers/form-signing-fakes';
import { RecordingMailer } from '../../test/helpers/mailer-fakes';
import { pdftotext } from '../../test/helpers/pdf-render';
import { blankPng, signaturePng } from '../../test/helpers/png-fixtures';
import { MailerService } from '../mailer/mailer.service';
import { DocumentNotificationsService } from './document-notifications.service';
import { DocumentSubjectsRepository } from './document-subjects.repository';
import { FormSigningRepository } from './form-signing.repository';
import { FormSigningService } from './form-signing.service';
import type { PublicForm } from './form-templates.types';
import { PdfWorkQueue } from './pdf-work-queue';
import { PrivateStorageClient } from './private-storage.client';
import { SignFormsController } from './sign-forms.controller';
import { SignFormsThrottlerGuard } from './sign-forms-throttler.guard';
import { signingBodyParser } from './signing-body-parser';
import { storageKeys } from './storage-keys';
import { sha256Hex } from './template-pdf';

jest.setTimeout(30_000);

const SLUG = 'lesson-waiver';
const TEMPLATE_ID = randomUUID();
const png = (buffer = signaturePng()) =>
  `data:image/png;base64,${buffer.toString('base64')}`;

describe('public form signing (/sign/forms)', () => {
  let app: INestApplication<App>;
  let forms: InMemoryFormSigningRepository;
  let storage: InMemoryPrivateStorage;
  let mailer: RecordingMailer;
  let ipCounter = 0;

  beforeEach(async () => {
    forms = new InMemoryFormSigningRepository();
    storage = new InMemoryPrivateStorage();
    mailer = new RecordingMailer();
    forms.seedForm(SLUG, [
      formVersion(TEMPLATE_ID, 'en', 1),
      formVersion(TEMPLATE_ID, 'en', 2),
      formVersion(TEMPLATE_ID, 'en', 3, { published_at: null }),
      formVersion(TEMPLATE_ID, 'zh', 1, {
        body_markdown: '# 免责声明\n\n我了解滑雪的风险。',
      }),
    ]);
    forms.seedForm('draft-only', [
      formVersion(randomUUID(), 'en', 1, { published_at: null }),
    ]);
    app = await startDocumentsApp(
      Test.createTestingModule({
        controllers: [SignFormsController],
        providers: [
          FormSigningService,
          PdfWorkQueue,
          SignFormsThrottlerGuard,
          DocumentNotificationsService,
          { provide: FormSigningRepository, useValue: forms },
          { provide: PrivateStorageClient, useValue: storage },
          { provide: MailerService, useValue: mailer.asService() },
          {
            provide: DocumentSubjectsRepository,
            useValue: new InMemoryDocumentSubjectsRepository(),
          },
        ],
      }),
      (a) => a.use(signingBodyParser),
    );
  });

  afterEach(() => app.close());

  const nextIp = () => `203.0.113.${++ipCounter % 250}`;
  const get = (path: string, ip = nextIp()) =>
    request(app.getHttpServer()).get(path).set('fly-client-ip', ip);
  const complete = (body: Record<string, unknown>, ip = nextIp()) =>
    request(app.getHttpServer())
      .post(`/sign/forms/${SLUG}/complete`)
      .set('fly-client-ip', ip)
      .set('user-agent', 'Mobile Safari 18')
      .send(body);

  const validBody = (overrides: Record<string, unknown> = {}) => ({
    lang: 'en',
    version: 2,
    consent: true,
    answers: {
      participant_name: 'Mia Chen',
      email: 'Mia.Chen@Example.com',
      date: '2026-12-20',
    },
    signatures: { participant_signature: png() },
    ...overrides,
  });

  describe('GET /sign/forms/:slug', () => {
    it('returns the newest published version in the asked language', async () => {
      const res = await get(`/sign/forms/${SLUG}?lang=en`).expect(200);

      const body = res.body as PublicForm;
      expect(body).toMatchObject({
        slug: SLUG,
        lang: 'en',
        version: 2,
        title: 'Lesson waiver',
      });
      expect(body.bodyMarkdown).toContain('Release of liability v2');
      expect(body.fields).toEqual(
        expect.arrayContaining([
          {
            key: 'participant_name',
            type: 'text',
            label: 'Participant name',
            required: true,
          },
          {
            key: 'guardian_signature',
            type: 'signature',
            label: 'Guardian signature',
            required: false,
          },
        ]),
      );
      expect(body.fields).toHaveLength(10);
    });

    it('serves the Chinese version with Chinese labels', async () => {
      const res = await get(`/sign/forms/${SLUG}?lang=zh`).expect(200);

      expect(res.body).toMatchObject({ lang: 'zh', version: 1 });
      expect((res.body as PublicForm).fields[0].label).toBe('参与者姓名');
    });

    it('falls back to the other language when the asked one is not published', async () => {
      forms.forms[0].versions = forms.forms[0].versions.filter(
        (v) => v.language === 'en',
      );

      const res = await get(`/sign/forms/${SLUG}?lang=zh`).expect(200);

      expect(res.body).toMatchObject({ lang: 'en', version: 2 });
    });

    it('404s for an unknown slug and for a form with no published version', async () => {
      await get('/sign/forms/no-such-form').expect(404);
      await get('/sign/forms/draft-only').expect(404);
      await get('/sign/forms/Bad%20Slug').expect(404);
    });

    it('rejects an unsupported language', async () => {
      await get(`/sign/forms/${SLUG}?lang=fr`).expect(400);
    });
  });

  describe('POST /sign/forms/:slug/complete', () => {
    it('stores a signed PDF of the exact text, records the signature and emails the copy', async () => {
      const res = await complete(validBody()).expect(201);

      expect(res.body).toEqual({ status: 'signed', emailed: true });
      const [signed] = forms.signed;
      const [customer] = forms.customers;
      expect(customer).toMatchObject({
        email: 'mia.chen@example.com',
        first_name: 'Mia',
        last_name: 'Chen',
        shopify_customer_id: null,
      });
      const version = forms.forms[0].versions[1];
      expect(signed).toMatchObject({
        template_id: TEMPLATE_ID,
        subject_type: 'customer',
        subject_id: customer.id,
        status: 'completed',
        form_version: 2,
        language: 'en',
        signer_name: 'Mia Chen',
        signer_email: 'mia.chen@example.com',
        signer_user_agent: 'Mobile Safari 18',
        template_sha256: version.body_sha256,
        signed_key: storageKeys.customerDocument(customer.id, signed.id),
        field_values: {
          participant_name: 'Mia Chen',
          email: 'mia.chen@example.com',
          date: '2026-12-20',
        },
      });
      expect(signed.signer_ip).toMatch(/^203\.0\.113\./);
      const stored = storage.objects.get(signed.signed_key!)!;
      expect(stored.contentType).toBe('application/pdf');
      expect(sha256Hex(stored.body)).toBe(signed.signed_sha256);

      const text = (await pdftotext(stored.body)).replace(/\s+/g, ' ');
      expect(text).toContain('Release of liability v2');
      expect(text).toContain('I accept the risks of skiing.');
      expect(text).toContain('Wear a helmet');
      expect(text).toContain('Mia Chen');
      expect(text).toContain('2026-12-20');
      expect(text).toContain(version.body_sha256);
      expect(text).toContain('Mobile Safari 18');
      expect(text).toContain(signed.id);
      expect(text).toContain(`${SLUG}, version 2`);

      const [email] = mailer.sentOf('documents.completed');
      expect(email).toMatchObject({
        to: 'mia.chen@example.com',
        metadata: { assignmentId: signed.id, subjectType: 'customer' },
      });
      expect(email.attachments![0].content.equals(stored.body)).toBe(true);
    });

    it('reports emailed: false when the copy could not be sent, and keeps the signature', async () => {
      mailer.outcome = 'failed';

      const res = await complete(validBody()).expect(201);

      expect(res.body).toEqual({ status: 'signed', emailed: false });
      expect(forms.signed).toHaveLength(1);
    });

    it('stops emailing copies to one address after 5 an hour, from any IP, and still keeps every signature', async () => {
      const results: boolean[] = [];
      for (let i = 0; i < 7; i += 1) {
        const res = await complete(
          validBody(),
          `198.51.100.${20 + (i % 2)}`,
        ).expect(201);
        results.push((res.body as { emailed: boolean }).emailed);
      }

      expect(results).toEqual([true, true, true, true, true, false, false]);
      expect(forms.signed).toHaveLength(7);
      expect(mailer.sentOf('documents.completed')).toHaveLength(5);

      const other = await complete(
        validBody({
          answers: {
            participant_name: 'Leo Chen',
            email: 'leo@example.com',
            date: '2026-12-20',
          },
        }),
      ).expect(201);
      expect(other.body).toEqual({ status: 'signed', emailed: true });
    });

    it('stops emailing copies once 30 have gone out across all addresses in a minute', async () => {
      const send = (i: number) =>
        complete(
          validBody({
            answers: {
              participant_name: 'Mia Chen',
              email: `mia${i}@example.com`,
              date: '2026-12-20',
            },
          }),
        ).expect(201);
      for (let i = 0; i < 30; i += 1) {
        await send(i);
      }

      const res = await send(30);

      expect(res.body).toEqual({ status: 'signed', emailed: false });
      expect(forms.signed).toHaveLength(31);
      expect(mailer.sentOf('documents.completed')).toHaveLength(30);
    });

    it('does not email the copy when the send limit cannot be checked, and keeps the signature', async () => {
      forms.failCopyEmailClaim = true;

      const res = await complete(validBody()).expect(201);

      expect(res.body).toEqual({ status: 'signed', emailed: false });
      expect(forms.signed).toHaveLength(1);
      expect(mailer.sent).toHaveLength(0);
    });

    it('renders Chinese text on the Chinese version', async () => {
      await complete(validBody({ lang: 'zh', version: 1 })).expect(201);

      const stored = storage.objects.get(forms.signed[0].signed_key!)!;
      const text = await pdftotext(stored.body);
      expect(text).toContain('我了解滑雪的风险。');
      expect(text).toContain('参与者签名');
    });

    it('accepts the optional guardian, witness, ID and initials boxes, filled or blank', async () => {
      await complete(validBody()).expect(201);
      await complete(
        validBody({
          answers: {
            participant_name: 'Leo Chen',
            email: 'mia.chen@example.com',
            date: '2026-12-20',
            id_number: 'A1234567',
            initials: 'LC',
            guardian_name: 'Mia Chen',
            witness_name: 'Sam Lee',
          },
          signatures: {
            participant_signature: png(),
            guardian_signature: png(),
            witness_signature: png(),
          },
        }),
      ).expect(201);

      expect(forms.signed[1].field_values).toMatchObject({
        id_number: 'A1234567',
        guardian_name: 'Mia Chen',
      });
    });

    it('files signatures under the customer with the same email, in any case, and never matches by name', async () => {
      const shopify = forms.seedCustomer({
        email: 'mia.chen@example.com',
        first_name: 'Mia',
        last_name: 'Chen',
        shopify_customer_id: 7001,
      });

      await complete(validBody()).expect(201);
      await complete(
        validBody({
          answers: {
            participant_name: 'Leo Chen',
            email: 'MIA.CHEN@example.com',
            date: '2026-12-20',
          },
        }),
      ).expect(201);
      await complete(
        validBody({
          answers: {
            participant_name: 'Mia Chen',
            email: 'other@example.com',
            date: '2026-12-20',
          },
        }),
      ).expect(201);

      expect(forms.signed.map((s) => s.subject_id)).toEqual([
        shopify.id,
        shopify.id,
        expect.not.stringMatching(shopify.id),
      ]);
      expect(forms.customers).toHaveLength(2);
      expect(forms.customers[0]).toMatchObject({ first_name: 'Mia' });
    });

    it('409s on a version that is no longer the newest published one', async () => {
      const res = await complete(validBody({ version: 1 })).expect(409);

      expect((res.body as { message: string }).message).toMatch(/reload/);
      expect(forms.signed).toHaveLength(0);
    });

    it('404s for an unknown or unpublished form', async () => {
      await request(app.getHttpServer())
        .post('/sign/forms/draft-only/complete')
        .send(validBody({ version: 1 }))
        .expect(404);
    });

    it.each([
      [
        'a missing required answer',
        { answers: { participant_name: 'Mia Chen', email: 'mia@example.com' } },
        /Date \(date\) is required/,
      ],
      [
        'a malformed email',
        {
          answers: {
            participant_name: 'Mia',
            email: 'not-an-email',
            date: '2026-12-20',
          },
        },
        /must be an email/,
      ],
      [
        'a malformed date',
        {
          answers: {
            participant_name: 'Mia',
            email: 'mia@example.com',
            date: '20/12/2026',
          },
        },
        /must be a date/,
      ],
      ['a missing participant signature', { signatures: {} }, /is required/],
      [
        'an answer for a field the form does not have',
        {
          answers: {
            participant_name: 'Mia',
            email: 'mia@example.com',
            date: '2026-12-20',
            age: '9',
          },
        },
        /Unknown answer age/,
      ],
      [
        'a signature that is not a PNG',
        { signatures: { participant_signature: 'data:image/png;base64,AAAA' } },
        /not a PNG/,
      ],
      [
        'a signature over 200 KB',
        {
          signatures: {
            participant_signature: png(signaturePng(400, 160, { noise: true })),
          },
        },
        /larger than 200 KB/,
      ],
      [
        'a 10,000 × 10,000 signature that compresses to 97 KB',
        {
          signatures: { participant_signature: png(blankPng(10_000, 10_000)) },
        },
        /is too large: at most 1200 pixels wide, 600 high/,
      ],
      [
        'a signature wider than 1200 pixels',
        { signatures: { participant_signature: png(blankPng(1201, 100)) } },
        /is too large: at most 1200 pixels wide, 600 high/,
      ],
      [
        'a signature taller than 600 pixels',
        { signatures: { participant_signature: png(blankPng(300, 601)) } },
        /is too large: at most 1200 pixels wide, 600 high/,
      ],
      [
        'a 1200 × 600 signature, over the total pixel budget',
        { signatures: { participant_signature: png(blankPng(1200, 600)) } },
        /is too large: at most 1200 pixels wide, 600 high/,
      ],
      [
        'an interlaced signature',
        {
          signatures: {
            participant_signature: png(blankPng(300, 100, { interlace: 1 })),
          },
        },
        /8-bit, non-interlaced, single-frame PNG/,
      ],
      [
        'a 16-bit signature',
        {
          signatures: {
            participant_signature: png(
              blankPng(300, 100, { bitDepth: 16, colorType: 6 }),
            ),
          },
        },
        /8-bit, non-interlaced, single-frame PNG/,
      ],
      [
        'an animated signature',
        {
          signatures: {
            participant_signature: png(blankPng(300, 100, { animated: true })),
          },
        },
        /8-bit, non-interlaced, single-frame PNG/,
      ],
      [
        'a signature with a truncated header',
        {
          signatures: {
            participant_signature: png(blankPng(300, 100).subarray(0, 20)),
          },
        },
        /not a PNG/,
      ],
      ['no consent', { consent: false }, /Agree to sign/],
    ])('400s for %s and stores nothing', async (_case, overrides, message) => {
      const res = await complete(validBody(overrides)).expect(400);

      expect((res.body as { message: string }).message).toMatch(message);
      expect(forms.signed).toHaveLength(0);
      expect(storage.objects.size).toBe(0);
      expect(mailer.sent).toHaveLength(0);
    });

    it('accepts the largest signature the signing site exports, 1000 × 600', async () => {
      const big = signaturePng(1000, 600);
      expect(big.length).toBeLessThan(150 * 1024);

      await complete(
        validBody({ signatures: { participant_signature: png(big) } }),
      ).expect(201);

      expect(forms.signed).toHaveLength(1);
    });

    it('rejects a 10,000 × 10,000 signature without decoding it', async () => {
      const bomb = png(blankPng(10_000, 10_000));
      global.gc?.();
      const before = process.memoryUsage().rss;
      let peak = before;
      const sampler = setInterval(() => {
        peak = Math.max(peak, process.memoryUsage().rss);
      }, 5);

      await complete(
        validBody({ signatures: { participant_signature: bomb } }),
      ).expect(400);

      clearInterval(sampler);
      peak = Math.max(peak, process.memoryUsage().rss);
      console.log(
        `10,000 × 10,000 signature: RSS +${((peak - before) / 1024 / 1024).toFixed(1)} MB`,
      );
      expect(peak - before).toBeLessThan(50 * 1024 * 1024);
      expect(storage.objects.size).toBe(0);
    });

    it('removes the stored PDF when the signature cannot be recorded', async () => {
      forms.failInsert = true;

      await complete(validBody()).expect(500);

      expect(storage.objects.size).toBe(0);
      expect(storage.deleted).toHaveLength(1);
      expect(mailer.sent).toHaveLength(0);
    });
  });

  describe('throttling', () => {
    it('429s the 11th signature a minute from one IP, other IPs unaffected', async () => {
      const ip = '198.51.100.7';
      for (let i = 0; i < 10; i += 1) {
        await complete(validBody({ version: 1 }), ip).expect(409);
      }
      await complete(validBody({ version: 1 }), ip).expect(429);
      await complete(validBody({ version: 1 }), '198.51.100.8').expect(409);
    });

    it('429s the 31st form read a minute from one IP', async () => {
      const ip = '198.51.100.9';
      for (let i = 0; i < 30; i += 1) {
        await get(`/sign/forms/${SLUG}`, ip).expect(200);
      }
      await get(`/sign/forms/${SLUG}`, ip).expect(429);
    });
  });
});
