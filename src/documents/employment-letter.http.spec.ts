import { PDFDocument } from '@cantoo/pdf-lib';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import {
  INSTRUCTOR_AUTH,
  INSTRUCTOR_USER_ID,
  InMemoryDocumentSubjectsRepository,
  startDocumentsApp,
  UNVERIFIED_AUTH,
} from '../../test/helpers/documents-fakes';
import {
  seasonsProviders,
  seasonsRepo,
} from '../../test/helpers/seasons-fakes';
import { pdftotext } from '../../test/helpers/pdf-render';
import { recordingAudit } from '../../test/helpers/public-pages-fakes';
import { AuditService } from '../audit/audit.service';
import { DocumentSubjectsRepository } from './document-subjects.repository';
import {
  EMPLOYMENT_LETTER_DISABLED,
  EMPLOYMENT_LETTER_FLAG,
  EMPLOYMENT_LETTER_NOT_ELIGIBLE,
  EmploymentLetterService,
  LEGAL_NAME_REQUIRED,
} from './employment-letter.service';
import { INSTRUCTOR_PROFILE_NOT_FOUND } from './me-documents.service';
import { MeEmploymentLetterController } from './me-employment-letter.controller';
import { PdfWorkQueue } from './pdf-work-queue';

jest.setTimeout(30_000);

const binary = (
  res: request.Response,
  done: (err: Error | null, body: Buffer) => void,
) => {
  const chunks: Buffer[] = [];
  res.on('data', (chunk: Buffer) => chunks.push(chunk));
  res.on('end', () => done(null, Buffer.concat(chunks)));
};

async function start(env: Record<string, string>) {
  const subjects = new InMemoryDocumentSubjectsRepository();
  const app = await startDocumentsApp(
    Test.createTestingModule({
      controllers: [MeEmploymentLetterController],
      providers: [
        EmploymentLetterService,
        PdfWorkQueue,
        ...seasonsProviders(seasonsRepo('2025/26', '2026/27')),
        { provide: DocumentSubjectsRepository, useValue: subjects },
        { provide: AuditService, useValue: recordingAudit() },
        {
          provide: ConfigService,
          useValue: { get: (key: string) => env[key] },
        },
      ],
    }),
  );
  return { app, subjects, http: () => request(app.getHttpServer()) };
}

describe('employment letter (HTTP)', () => {
  let ctx: Awaited<ReturnType<typeof start>>;

  afterEach(async () => {
    await ctx.app.close();
  });

  describe('with the flag off', () => {
    beforeEach(async () => {
      ctx = await start({});
      ctx.subjects.seedInstructor({
        auth_user_id: INSTRUCTOR_USER_ID,
        first_name: 'Alice',
        last_name: 'Wang-Li',
      });
    });

    it('reports the feature as disabled', async () => {
      const res = await ctx
        .http()
        .get('/me/employment-letter')
        .set('Authorization', INSTRUCTOR_AUTH)
        .expect(200);
      expect(res.body).toEqual({ state: 'disabled', legalName: null });
    });

    it('does not generate a letter', async () => {
      const res = await ctx
        .http()
        .get('/me/employment-letter/letter.pdf')
        .set('Authorization', INSTRUCTOR_AUTH)
        .expect(404);
      expect(res.body).toMatchObject({ message: EMPLOYMENT_LETTER_DISABLED });
    });

    it('treats any value other than "true" as off', async () => {
      await ctx.app.close();
      ctx = await start({ [EMPLOYMENT_LETTER_FLAG]: 'yes' });
      const res = await ctx
        .http()
        .get('/me/employment-letter')
        .set('Authorization', INSTRUCTOR_AUTH)
        .expect(200);
      expect(res.body).toMatchObject({ state: 'disabled' });
    });
  });

  describe('with the flag on', () => {
    beforeEach(async () => {
      ctx = await start({ [EMPLOYMENT_LETTER_FLAG]: ' true ' });
    });

    it('generates a PDF with the legal name, issue date and current season', async () => {
      ctx.subjects.seedInstructor({
        auth_user_id: INSTRUCTOR_USER_ID,
        first_name: ' Alice ',
        last_name: 'Wang-Li',
        display_name_en: 'Ally',
        email: 'alice@example.com',
      });

      const status = await ctx
        .http()
        .get('/me/employment-letter')
        .set('Authorization', INSTRUCTOR_AUTH)
        .expect(200);
      expect(status.body).toEqual({
        state: 'ready',
        legalName: 'Alice Wang-Li',
      });

      const res = await ctx
        .http()
        .get('/me/employment-letter/letter.pdf')
        .set('Authorization', INSTRUCTOR_AUTH)
        .buffer(true)
        .parse(binary)
        .expect(200);
      expect(res.headers['content-type']).toBe('application/pdf');
      expect(res.headers['content-disposition']).toBe(
        'attachment; filename="employment-letter-2026-10-15.pdf"',
      );
      expect(res.headers['cache-control']).toBe('no-store');
      const bytes = new Uint8Array(res.body as Buffer);
      expect((await PDFDocument.load(bytes)).getPageCount()).toBe(1);
      const text = (await pdftotext(bytes)).replace(/\s+/g, ' ');
      expect(text).toContain('Alice Wang-Li');
      expect(text).not.toContain('Ally');
      expect(text).toContain('October 15, 2026');
      expect(text).toContain(
        '2026/27 season (November 1, 2026 to April 30, 2027)',
      );
      expect(text).not.toContain('{{');
    });

    it.each([
      ['no names', { first_name: null, last_name: null }],
      ['no last name', { first_name: 'Alice', last_name: null }],
      ['a blank first name', { first_name: '  ', last_name: 'Wang' }],
    ])('asks for the legal name when there are %s', async (_label, names) => {
      ctx.subjects.seedInstructor({
        auth_user_id: INSTRUCTOR_USER_ID,
        display_name_en: 'Ally',
        ...names,
      });

      const status = await ctx
        .http()
        .get('/me/employment-letter')
        .set('Authorization', INSTRUCTOR_AUTH)
        .expect(200);
      expect(status.body).toEqual({
        state: 'legal_name_missing',
        legalName: null,
      });
      const res = await ctx
        .http()
        .get('/me/employment-letter/letter.pdf')
        .set('Authorization', INSTRUCTOR_AUTH)
        .expect(409);
      expect(res.body).toMatchObject({ message: LEGAL_NAME_REQUIRED });
    });

    it.each([
      ['pending', { approval_status: 'pending' }],
      ['rejected', { approval_status: 'rejected' }],
      ['deactivated', { is_active: false }],
    ])('refuses a %s instructor', async (_label, overrides) => {
      ctx.subjects.seedInstructor({
        auth_user_id: INSTRUCTOR_USER_ID,
        first_name: 'Alice',
        last_name: 'Wang',
        ...overrides,
      });

      const status = await ctx
        .http()
        .get('/me/employment-letter')
        .set('Authorization', INSTRUCTOR_AUTH)
        .expect(200);
      expect(status.body).toEqual({ state: 'not_eligible', legalName: null });
      const res = await ctx
        .http()
        .get('/me/employment-letter/letter.pdf')
        .set('Authorization', INSTRUCTOR_AUTH)
        .expect(403);
      expect(res.body).toMatchObject({
        message: EMPLOYMENT_LETTER_NOT_ELIGIBLE,
      });
    });

    it('answers 404 when the caller has no instructor profile', async () => {
      const res = await ctx
        .http()
        .get('/me/employment-letter/letter.pdf')
        .set('Authorization', INSTRUCTOR_AUTH)
        .expect(404);
      expect(res.body).toMatchObject({ message: INSTRUCTOR_PROFILE_NOT_FOUND });
    });

    it('requires a verified email', async () => {
      await ctx
        .http()
        .get('/me/employment-letter')
        .set('Authorization', UNVERIFIED_AUTH)
        .expect(403);
      await ctx
        .http()
        .get('/me/employment-letter/letter.pdf')
        .set('Authorization', UNVERIFIED_AUTH)
        .expect(403);
    });

    it('requires a token', async () => {
      await ctx.http().get('/me/employment-letter').expect(401);
    });
  });
});
