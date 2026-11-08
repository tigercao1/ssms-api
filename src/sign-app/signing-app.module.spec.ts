import { randomUUID } from 'node:crypto';
import { type INestApplication, Logger } from '@nestjs/common';
import { ModulesContainer } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import {
  InMemoryDocumentSubjectsRepository,
  InMemoryPrivateStorage,
} from '../../test/helpers/documents-fakes';
import {
  formVersion,
  InMemoryFormSigningRepository,
} from '../../test/helpers/form-signing-fakes';
import { listRoutes } from '../../test/helpers/http-routes';
import { RecordingMailer } from '../../test/helpers/mailer-fakes';
import { signaturePng } from '../../test/helpers/png-fixtures';
import { SUPABASE_CLIENT } from '../database/supabase-client.token';
import { DocumentSubjectsRepository } from '../documents/document-subjects.repository';
import { FormSigningRepository } from '../documents/form-signing.repository';
import { PrivateStorageClient } from '../documents/private-storage.client';
import { MailerService } from '../mailer/mailer.service';
import { configureSignApp } from './configure-sign-app';
import { SigningAppModule } from './signing-app.module';

jest.setTimeout(30_000);

const SIGN_ORIGIN = 'https://sign.ssnow.club';
const SLUG = 'lesson-waiver';

describe('SigningAppModule', () => {
  let app: INestApplication<App>;
  let forms: InMemoryFormSigningRepository;
  let storage: InMemoryPrivateStorage;
  let mailer: RecordingMailer;
  const originalCors = process.env.CORS_ALLOWED_ORIGINS;

  beforeEach(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger, 'log').mockImplementation();
    process.env.CORS_ALLOWED_ORIGINS = SIGN_ORIGIN;
    forms = new InMemoryFormSigningRepository();
    forms.seedForm(SLUG, [formVersion(randomUUID(), 'en', 1)]);
    storage = new InMemoryPrivateStorage();
    mailer = new RecordingMailer();
    const supabase = {
      from: jest.fn(() => ({
        select: () => Promise.resolve({ error: null }),
      })),
    };
    const moduleRef = await Test.createTestingModule({
      imports: [SigningAppModule],
    })
      .overrideProvider(SUPABASE_CLIENT)
      .useValue(supabase)
      .overrideProvider(FormSigningRepository)
      .useValue(forms)
      .overrideProvider(PrivateStorageClient)
      .useValue(storage)
      .overrideProvider(MailerService)
      .useValue(mailer.asService())
      .overrideProvider(DocumentSubjectsRepository)
      .useValue(new InMemoryDocumentSubjectsRepository())
      .compile();
    app = moduleRef.createNestApplication<INestApplication<App>>();
    configureSignApp(app);
    await app.listen(0, '127.0.0.1');
  });

  afterEach(async () => {
    await app.close();
    process.env.CORS_ALLOWED_ORIGINS = originalCors;
    jest.restoreAllMocks();
  });

  it('loads only config, database, health, mailer and form signing modules', () => {
    const modules = [...app.get(ModulesContainer).values()]
      .map((module) => module.metatype.name)
      .filter((name) => name !== 'RootTestModule');

    expect(modules.sort()).toEqual(
      [
        'ConfigHostModule',
        'ConfigModule',
        'DatabaseModule',
        'DocumentsCoreModule',
        'FormSigningModule',
        'HealthModule',
        'InternalCoreModule',
        'MailerCoreModule',
        'SigningAppModule',
      ].sort(),
    );
    expect(modules.join(' ')).not.toMatch(
      /Auth|Admin|Instructor|Shopify|Google|Gemini|Translation|Reminder|Payroll/,
    );
  });

  it('serves only /health and the public form signing routes', async () => {
    expect(listRoutes(app)).toEqual([
      'GET /health',
      'GET /sign/forms/:slug',
      'POST /sign/forms/:slug/complete',
    ]);
    await request(app.getHttpServer()).get('/admin/signatures').expect(404);
    await request(app.getHttpServer()).get('/me/documents/x').expect(404);
    await request(app.getHttpServer()).get('/').expect(404);
  });

  it('answers the Fly health check', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ keys: [{}] })));

    const res = await request(app.getHttpServer()).get('/health').expect(200);

    expect(res.body).toEqual({ status: 'ok', db: 'ok', jwks: 'ok' });
  });

  it('serves a published form and accepts a signature', async () => {
    const form = await request(app.getHttpServer())
      .get(`/sign/forms/${SLUG}?lang=en`)
      .expect(200);
    expect(form.body).toMatchObject({ slug: SLUG, lang: 'en', version: 1 });

    const png = `data:image/png;base64,${signaturePng().toString('base64')}`;
    const signed = await request(app.getHttpServer())
      .post(`/sign/forms/${SLUG}/complete`)
      .set('fly-client-ip', '203.0.113.7')
      .send({
        lang: 'en',
        version: 1,
        consent: true,
        answers: {
          participant_name: 'Mia Chen',
          email: 'mia@example.com',
          date: '2026-12-20',
        },
        signatures: { participant_signature: png },
      })
      .expect(201);

    expect(signed.body).toMatchObject({ emailed: true });
    expect(forms.signed).toHaveLength(1);
    expect(storage.objects.size).toBe(1);
  });

  it('allows cross-origin requests from CORS_ALLOWED_ORIGINS only', async () => {
    const allowed = await request(app.getHttpServer())
      .options(`/sign/forms/${SLUG}/complete`)
      .set('Origin', SIGN_ORIGIN)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type');
    expect(allowed.headers['access-control-allow-origin']).toBe(SIGN_ORIGIN);
    expect(allowed.headers['access-control-allow-methods']).toBe('GET,POST');
    expect(allowed.headers['access-control-allow-headers']).toBe(
      'Content-Type',
    );
    expect(allowed.headers['access-control-allow-credentials']).toBeUndefined();

    const other = await request(app.getHttpServer())
      .get(`/sign/forms/${SLUG}`)
      .set('Origin', 'https://app.ssnow.club')
      .expect(200);
    expect(other.headers['access-control-allow-origin']).toBeUndefined();
  });
});
