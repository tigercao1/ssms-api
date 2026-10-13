import {
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { Request } from 'express';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AuditService } from '../audit/audit.service';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { en, zhCN } from '../i18n';
import {
  EmailPreviewController,
  type EmailPreviewSummary,
} from './email-preview.controller';
import { MailerConfig } from './mailer.config';
import { EmailRenderer } from './templates/email-renderer';
import { EMAIL_TEMPLATE_NAMES } from './templates/email-templates';

class FakeJwtGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const role = /^Bearer jwt-(\w+)$/.exec(
      req.headers.authorization ?? '',
    )?.[1];
    if (!role) {
      throw new UnauthorizedException();
    }
    (req as Request & { user: unknown }).user = {
      sub: 'user-1',
      app_metadata: { role },
    };
    return true;
  }
}

describe('/admin/email-previews', () => {
  let app: INestApplication<App>;
  const admin = 'Bearer jwt-admin';

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [EmailPreviewController],
      providers: [
        EmailRenderer,
        MailerConfig,
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) =>
              ({ PORTAL_URL: 'https://portal.example.com' })[key],
          },
        },
        {
          provide: AuditService,
          useValue: { record: () => Promise.resolve() },
        },
      ],
    })
      .overrideGuard(SupabaseAuthGuard)
      .useClass(FakeJwtGuard)
      .compile();
    app = moduleRef.createNestApplication<INestApplication<App>>();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  const http = () => request(app.getHttpServer());

  it.each(['/admin/email-previews', '/admin/email-previews/approved'])(
    '%s needs a JWT (401) and an admin role (403)',
    async (path) => {
      await http().get(path).expect(401);
      await http()
        .get(path)
        .set('Authorization', 'Bearer jwt-instructor')
        .expect(403);
    },
  );

  it('lists every template with subjects and preview paths per language', async () => {
    const res = await http()
      .get('/admin/email-previews')
      .set('Authorization', admin)
      .expect(200);
    const body = res.body as EmailPreviewSummary[];
    expect(body.map((t) => t.template)).toEqual(EMAIL_TEMPLATE_NAMES);
    const approved = body.find((t) => t.template === 'approved')!;
    expect(approved.subjects).toEqual({
      en: en.email.approved.subject,
      'zh-CN': zhCN.email.approved.subject,
      bilingual: `${en.email.approved.subject} / ${zhCN.email.approved.subject}`,
    });
    expect(approved.previewPaths['zh-CN']).toBe(
      '/admin/email-previews/approved?lang=zh-CN',
    );
  });

  it('returns rendered HTML with sample vars, defaulting to bilingual', async () => {
    const res = await http()
      .get('/admin/email-previews/approved')
      .set('Authorization', admin)
      .expect(200)
      .expect('Content-Type', /text\/html/)
      .expect('Cache-Control', 'no-store');
    expect(res.text).toContain(zhCN.email.approved.heading);
    expect(res.text).toContain(en.email.approved.heading);
    expect(res.text).toContain('href="https://portal.example.com/login"');
  });

  it('renders a single language with ?lang=', async () => {
    const res = await http()
      .get('/admin/email-previews/auth.magic_link?lang=en')
      .set('Authorization', admin)
      .expect(200);
    expect(res.text).toContain(en.email.auth.magicLink.heading);
    expect(res.text).not.toContain(zhCN.email.auth.magicLink.heading);
  });

  it('shows the plain-text alternative with ?format=text', async () => {
    const res = await http()
      .get('/admin/email-previews/rejected?lang=en&format=text')
      .set('Authorization', admin)
      .expect(200);
    expect(res.text).toContain('<pre');
    expect(res.text).toContain(
      en.email.rejected.closing.replace(/'/g, '&#39;'),
    );
  });

  it('404s an unknown template and 400s an unknown language', async () => {
    await http()
      .get('/admin/email-previews/nope')
      .set('Authorization', admin)
      .expect(404);
    await http()
      .get('/admin/email-previews/approved?lang=fr')
      .set('Authorization', admin)
      .expect(400);
  });
});
