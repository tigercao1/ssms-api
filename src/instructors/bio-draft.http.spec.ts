import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Server } from 'node:http';
import request from 'supertest';
import { EmailVerifiedGuard } from '../auth/email-verified.guard';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import {
  BIO_TRANSLATOR,
  type BioTranslator,
} from '../bio-translation/bio-translator.interface';
import { MailerService } from '../mailer/mailer.service';
import {
  BioAiQuotaRepository,
  type BioAiReservation,
  type BioAiWindow,
} from './bio-ai-quota.repository';
import { BioDraftService } from './bio-draft.service';
import { InstructorsController } from './instructors.controller';
import { InstructorsRepository } from './instructors.repository';
import { InstructorsService } from './instructors.service';
import type {
  InstructorProfilePatch,
  InstructorRow,
} from './instructors.types';
import { TRANSLATION_QUEUE } from './translation-queue.port';

const NOW_ISO = '2026-10-14T03:00:00.000Z';

class InMemoryInstructors extends InstructorsRepository {
  patches: InstructorProfilePatch[] = [];
  row: InstructorRow = {
    id: 'inst-1',
    auth_user_id: 'auth-1',
    email: 'eddie@example.test',
    display_name_en: 'Eddie',
    display_name_zh: null,
    bio_en: 'Old',
    bio_zh: null,
    bio_en_machine_translated: false,
    bio_zh_machine_translated: false,
    bio_en_translated_by: null,
    bio_zh_translated_by: null,
    bio_en_updated_at: '2026-10-01T12:00:00.5+00:00',
    bio_zh_updated_at: null,
    date_of_birth: null,
    profile_photo_url: null,
    photo_2_url: null,
    photo_3_url: null,
    min_student_age: 5,
    display_order: null,
    preferred_language: 'en',
    approval_status: 'approved',
    is_active: true,
    inserted_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };

  findByAuthUserId(authUserId: string) {
    return Promise.resolve(authUserId === 'auth-1' ? this.row : null);
  }
  findById(id: string) {
    return Promise.resolve(id === this.row.id ? { ...this.row } : null);
  }
  insertPending() {
    return Promise.resolve(null);
  }
  getTeachingLocations() {
    return Promise.resolve([]);
  }
  getLanguages() {
    return Promise.resolve([]);
  }
  getCourseLevels() {
    return Promise.resolve([]);
  }
  getCertifications() {
    return Promise.resolve([]);
  }
  getTrainerStatus() {
    return Promise.resolve([]);
  }
  applyProfilePatch(_id: string, patch: InstructorProfilePatch) {
    this.patches.push(patch);
    if (patch.bio_zh !== undefined) {
      this.row.bio_zh = patch.bio_zh;
      this.row.bio_zh_machine_translated =
        patch.bio_zh_machine_translated ?? false;
      this.row.bio_zh_translated_by = patch.bio_zh_translated_by ?? null;
      this.row.bio_zh_updated_at = NOW_ISO;
    }
    return Promise.resolve();
  }
  bumpProfilePhotoVersion() {
    return Promise.resolve();
  }
  setAdditionalPhoto() {
    return Promise.resolve();
  }
  listAdminRecipients() {
    return Promise.resolve([]);
  }
}

class CountingQuota extends BioAiQuotaRepository {
  used = 0;
  released: string[] = [];
  usage(): Promise<BioAiWindow> {
    return Promise.resolve({
      used: this.used,
      oldestAt: this.used ? NOW_ISO : null,
    });
  }
  reserve(
    _id: string,
    _mode: string,
    limit: number,
  ): Promise<BioAiReservation> {
    if (this.used >= limit) {
      return Promise.resolve({
        requestId: null,
        used: this.used,
        oldestAt: NOW_ISO,
      });
    }
    this.used += 1;
    return Promise.resolve({
      requestId: `req-${this.used}`,
      used: this.used,
      oldestAt: NOW_ISO,
    });
  }
  release(requestId: string): Promise<void> {
    this.released.push(requestId);
    this.used -= 1;
    return Promise.resolve();
  }
}

async function build(translator: BioTranslator) {
  const repo = new InMemoryInstructors();
  const quota = new CountingQuota();
  const queue = { enqueueForProfile: jest.fn().mockResolvedValue(true) };
  const moduleRef = await Test.createTestingModule({
    controllers: [InstructorsController],
    providers: [
      InstructorsService,
      BioDraftService,
      { provide: InstructorsRepository, useValue: repo },
      { provide: BioAiQuotaRepository, useValue: quota },
      { provide: TRANSLATION_QUEUE, useValue: queue },
      { provide: MailerService, useValue: {} },
      { provide: BIO_TRANSLATOR, useValue: translator },
    ],
  })
    .overrideGuard(SupabaseAuthGuard)
    .useValue({
      canActivate: (ctx: {
        switchToHttp: () => { getRequest: () => { user: unknown } };
      }) => {
        ctx.switchToHttp().getRequest().user = { sub: 'auth-1' };
        return true;
      },
    })
    .overrideGuard(EmailVerifiedGuard)
    .useValue({ canActivate: () => true })
    .compile();
  const app = moduleRef.createNestApplication<INestApplication>();
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  await app.init();
  return {
    app,
    repo,
    quota,
    queue,
    http: () => request(app.getHttpServer() as Server),
  };
}

describe('bio draft routes (HTTP)', () => {
  let ctx: Awaited<ReturnType<typeof build>>;
  const draft = jest.fn();
  const gemini: BioTranslator = {
    modelId: 'gemini-server',
    translate: jest.fn(),
    draft,
  };

  beforeEach(async () => {
    draft.mockReset();
    draft.mockResolvedValue({
      en: 'I teach skiing.',
      zh: '我教滑雪。',
      sourceLangs: ['en'],
    });
    ctx = await build(gemini);
  });
  afterEach(async () => {
    await ctx.app.close();
  });

  it('GET /me/instructor/bio/ai-usage returns the usage', async () => {
    const res = await ctx.http().get('/me/instructor/bio/ai-usage').expect(200);
    expect(res.body).toEqual({
      limit: 5,
      used: 0,
      remaining: 5,
      resetsAt: null,
    });
  });

  it('POST /me/instructor/bio/draft answers 200 with both languages', async () => {
    const res = await ctx
      .http()
      .post('/me/instructor/bio/draft')
      .send({ text: 'I teach skiing.', mode: 'refine' })
      .expect(200);
    expect(res.body).toEqual({
      en: 'I teach skiing.',
      zh: '我教滑雪。',
      sourceLangs: ['en'],
      model: 'gemini-server',
      usage: {
        limit: 5,
        used: 1,
        remaining: 4,
        resetsAt: '2026-10-15T03:00:00.000Z',
      },
    });
    expect(ctx.repo.patches).toEqual([]);
  });

  it('answers 429 bio_ai_limit with the usage when no slot is left', async () => {
    ctx.quota.used = 5;
    const res = await ctx
      .http()
      .post('/me/instructor/bio/draft')
      .send({ text: 'Hi', mode: 'translate' })
      .expect(429);
    expect(res.body).toEqual({
      code: 'bio_ai_limit',
      usage: {
        limit: 5,
        used: 5,
        remaining: 0,
        resetsAt: '2026-10-15T03:00:00.000Z',
      },
    });
    expect(draft).not.toHaveBeenCalled();
  });

  it('answers 503 bio_ai_unavailable and releases the slot when Gemini fails', async () => {
    draft.mockRejectedValue(new Error('Gemini timed out'));
    const res = await ctx
      .http()
      .post('/me/instructor/bio/draft')
      .send({ text: 'Hi', mode: 'refine' })
      .expect(503);
    expect(res.body).toEqual({ code: 'bio_ai_unavailable' });
    expect(ctx.quota.released).toEqual(['req-1']);
    expect(ctx.quota.used).toBe(0);
  });

  it.each([
    ['blank text', { text: '   ', mode: 'refine' }],
    ['missing text', { mode: 'refine' }],
    ['text over 2000 characters', { text: 'x'.repeat(2001), mode: 'refine' }],
    ['an unknown mode', { text: 'Hi', mode: 'shorten' }],
    ['an extra field', { text: 'Hi', mode: 'refine', save: true }],
  ])('rejects %s with 400', async (_label, body) => {
    await ctx.http().post('/me/instructor/bio/draft').send(body).expect(400);
    expect(ctx.quota.used).toBe(0);
  });

  it('accepts text of exactly 2000 characters', async () => {
    await ctx
      .http()
      .post('/me/instructor/bio/draft')
      .send({ text: 'x'.repeat(2000), mode: 'translate' })
      .expect(200);
  });

  it('GET /me/instructor exposes the bio timestamps', async () => {
    const res = await ctx.http().get('/me/instructor').expect(200);
    expect(res.body).toMatchObject({
      bioEnUpdatedAt: '2026-10-01T12:00:00.500Z',
      bioZhUpdatedAt: null,
    });
  });

  it('PATCH stores a flagged bio as machine-translated by the server model, without enqueuing', async () => {
    const res = await ctx
      .http()
      .patch('/me/instructor')
      .send({ bioZh: '我教滑雪。', bioZhMachineTranslated: true })
      .expect(200);
    expect(ctx.repo.patches).toEqual([
      {
        bio_zh: '我教滑雪。',
        bio_zh_machine_translated: true,
        bio_zh_translated_by: 'gemini-server',
      },
    ]);
    expect(res.body).toMatchObject({
      bioZhMachineTranslated: true,
      bioZhTranslatedBy: 'gemini-server',
      bioZhUpdatedAt: NOW_ISO,
    });
    expect(ctx.queue.enqueueForProfile).not.toHaveBeenCalled();
  });

  it.each([
    ['a non-boolean flag', { bioZh: '你好', bioZhMachineTranslated: 'yes' }],
    ['a client translated_by', { bioZh: '你好', bioZhTranslatedBy: 'x' }],
  ])('PATCH rejects %s with 400', async (_label, body) => {
    await ctx.http().patch('/me/instructor').send(body).expect(400);
    expect(ctx.repo.patches).toEqual([]);
  });
});

describe('bio draft routes with translation disabled (HTTP)', () => {
  it('answers 503 bio_ai_unavailable without using a slot', async () => {
    const ctx = await build({ modelId: null, translate: jest.fn() });
    try {
      const res = await ctx
        .http()
        .post('/me/instructor/bio/draft')
        .send({ text: 'Hi', mode: 'refine' })
        .expect(503);
      expect(res.body).toEqual({ code: 'bio_ai_unavailable' });
      expect(ctx.quota.used).toBe(0);
    } finally {
      await ctx.app.close();
    }
  });
});
