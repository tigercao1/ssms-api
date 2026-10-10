import {
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
  NotFoundException,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { Request } from 'express';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AdminMediaController } from '../admin/admin-media.controller';
import { AdminService } from '../admin/admin.service';
import { EmailVerifiedGuard } from '../auth/email-verified.guard';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { InstructorsRepository } from '../instructors/instructors.repository';
import { InstructorsService } from '../instructors/instructors.service';
import type {
  InstructorProfile,
  InstructorProfilePatch,
  InstructorRow,
} from '../instructors/instructors.types';
import { TRANSLATION_QUEUE } from '../instructors/translation-queue.port';
import { MediaController } from './media.controller';
import { MediaService } from './media.service';
import { STORAGE_CLIENT, type StorageClient } from './storage-client';

const INSTRUCTOR_ID = '3f1c2b7a-9d4e-4c1a-8b2f-6a7e5d4c3b2a';
const UNKNOWN_ID = '5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b';
const PUBLIC_BASE = 'https://storage.test/object/public/instructor-public';

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
      sub: 'auth-1',
      email: 'eddie@example.test',
      app_metadata: { role },
    };
    return true;
  }
}

class InMemoryInstructors extends InstructorsRepository {
  row: InstructorRow = {
    id: INSTRUCTOR_ID,
    auth_user_id: 'auth-1',
    email: 'eddie@example.test',
    display_name_en: 'Eddie',
    display_name_zh: null,
    bio_en: null,
    bio_zh: null,
    bio_en_machine_translated: false,
    bio_zh_machine_translated: false,
    bio_en_translated_by: null,
    bio_zh_translated_by: null,
    date_of_birth: null,
    profile_photo_url: null,
    photo_2_url: null,
    photo_3_url: null,
    min_student_age: 5,
    preferred_language: 'en',
    approval_status: 'approved',
    is_active: true,
    inserted_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };
  versions: Record<1 | 2 | 3, number> = { 1: 0, 2: 0, 3: 0 };

  findByAuthUserId(authUserId: string) {
    return Promise.resolve(
      authUserId === this.row.auth_user_id ? this.row : null,
    );
  }
  findById(id: string) {
    return Promise.resolve(id === this.row.id ? this.row : null);
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
    if (
      patch.profile_photo_url !== undefined &&
      patch.profile_photo_url !== this.row.profile_photo_url
    ) {
      this.row.profile_photo_url = patch.profile_photo_url;
      this.versions[1] += 1;
    }
    return Promise.resolve();
  }
  bumpProfilePhotoVersion() {
    this.versions[1] += 1;
    return Promise.resolve();
  }
  setAdditionalPhoto(_id: string, slot: 2 | 3, url: string | null) {
    this.row[slot === 2 ? 'photo_2_url' : 'photo_3_url'] = url;
    this.versions[slot] += 1;
    return Promise.resolve();
  }
}

class FakeStorage implements StorageClient {
  signed: string[] = [];
  createSignedUploadUrl(bucket: string, path: string) {
    this.signed.push(path);
    return Promise.resolve({
      signedUrl: `https://storage.test/upload/${bucket}/${path}`,
      token: 't',
      path,
    });
  }
  getPublicUrl(bucket: string, path: string) {
    return `https://storage.test/object/public/${bucket}/${path}`;
  }
}

async function build() {
  const repo = new InMemoryInstructors();
  const storage = new FakeStorage();
  const moduleRef = await Test.createTestingModule({
    controllers: [MediaController, AdminMediaController],
    providers: [
      MediaService,
      InstructorsService,
      { provide: InstructorsRepository, useValue: repo },
      {
        provide: TRANSLATION_QUEUE,
        useValue: { enqueueForProfile: () => Promise.resolve(false) },
      },
      { provide: STORAGE_CLIENT, useValue: storage },
      { provide: ConfigService, useValue: { get: () => undefined } },
      {
        provide: AdminService,
        useValue: {
          getInstructor: (id: string) =>
            id === INSTRUCTOR_ID
              ? Promise.resolve({ id })
              : Promise.reject(new NotFoundException()),
        },
      },
    ],
  })
    .overrideGuard(SupabaseAuthGuard)
    .useClass(FakeJwtGuard)
    .overrideGuard(EmailVerifiedGuard)
    .useValue({ canActivate: () => true })
    .compile();
  const app = moduleRef.createNestApplication<INestApplication<App>>();
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  await app.init();
  return { app, repo, storage };
}

describe.each([
  ['instructor', '/me/instructor/photo', 'Bearer jwt-instructor'],
  ['admin', `/admin/instructors/${INSTRUCTOR_ID}/photo`, 'Bearer jwt-admin'],
])('photo slots via the %s routes', (_label, base, auth) => {
  let ctx: Awaited<ReturnType<typeof build>>;
  const http = () => request(ctx.app.getHttpServer());

  beforeEach(async () => {
    ctx = await build();
  });
  afterEach(async () => {
    await ctx.app.close();
  });

  const upload = (body: object) =>
    http()
      .post(`${base}/signed-upload-url`)
      .set('Authorization', auth)
      .send(body);
  const confirm = (body: object) =>
    http().post(`${base}/confirm`).set('Authorization', auth).send(body);
  const remove = (slot: string) =>
    http().delete(`${base}/${slot}`).set('Authorization', auth);

  it('defaults to slot 1 at the existing avatar path', async () => {
    const res = await upload({
      contentType: 'image/jpeg',
      contentLength: 10,
    }).expect(201);
    expect(res.body).toMatchObject({
      path: `${INSTRUCTOR_ID}/avatar.jpg`,
      publicUrl: `${PUBLIC_BASE}/${INSTRUCTOR_ID}/avatar.jpg`,
    });

    const confirmed = await confirm({ contentType: 'image/jpeg' }).expect(201);
    expect(confirmed.body).toMatchObject({
      profilePhotoUrl: `${PUBLIC_BASE}/${INSTRUCTOR_ID}/avatar.jpg`,
      photo2Url: null,
      photo3Url: null,
    });
    expect(ctx.repo.versions).toEqual({ 1: 2, 2: 0, 3: 0 });
  });

  it.each([
    [2, 'image/png', 'photo-2.png', 'photo2Url'],
    [3, 'image/webp', 'photo-3.webp', 'photo3Url'],
  ])(
    'uploads and confirms slot %i at its own path and field',
    async (slot, contentType, file, field) => {
      const res = await upload({ contentType, contentLength: 10, slot }).expect(
        201,
      );
      expect((res.body as { path: string }).path).toBe(
        `${INSTRUCTOR_ID}/${file}`,
      );

      const confirmed = await confirm({ contentType, slot }).expect(201);
      expect((confirmed.body as Record<string, unknown>)[field]).toBe(
        `${PUBLIC_BASE}/${INSTRUCTOR_ID}/${file}`,
      );
      expect((confirmed.body as InstructorProfile).profilePhotoUrl).toBeNull();
      expect(ctx.repo.versions[slot as 2 | 3]).toBe(1);
      expect(ctx.repo.versions[1]).toBe(0);
    },
  );

  it.each([0, 4, '2', null])('rejects slot %p with 400', async (slot) => {
    await upload({ contentType: 'image/png', contentLength: 10, slot }).expect(
      400,
    );
    await confirm({ contentType: 'image/png', slot }).expect(400);
    expect(ctx.storage.signed).toHaveLength(0);
    expect(ctx.repo.versions).toEqual({ 1: 0, 2: 0, 3: 0 });
  });

  it('applies the type and size limits to extra slots', async () => {
    await upload({
      contentType: 'image/gif',
      contentLength: 10,
      slot: 2,
    }).expect(400);
    await upload({
      contentType: 'image/png',
      contentLength: 5 * 1024 * 1024 + 1,
      slot: 3,
    }).expect(413);
  });

  it('DELETE clears only the requested slot and bumps its version', async () => {
    ctx.repo.row.profile_photo_url = 'https://cdn.test/a.jpg';
    ctx.repo.row.photo_2_url = 'https://cdn.test/2.jpg';
    ctx.repo.row.photo_3_url = 'https://cdn.test/3.jpg';

    const res = await remove('2').expect(200);
    expect(res.body).toMatchObject({
      profilePhotoUrl: 'https://cdn.test/a.jpg',
      photo2Url: null,
      photo3Url: 'https://cdn.test/3.jpg',
    });
    expect(ctx.repo.versions).toEqual({ 1: 0, 2: 1, 3: 0 });
  });

  it('DELETE slot 1 clears the profile photo', async () => {
    ctx.repo.row.profile_photo_url = 'https://cdn.test/a.jpg';
    const res = await remove('1').expect(200);
    expect((res.body as InstructorProfile).profilePhotoUrl).toBeNull();
    expect(ctx.repo.versions[1]).toBe(1);
  });

  it.each(['0', '4', 'two'])(
    'DELETE rejects slot %s with 400',
    async (slot) => {
      await remove(slot).expect(400);
    },
  );

  it('needs a JWT', async () => {
    await http().delete(`${base}/2`).expect(401);
  });
});

describe('admin photo slot routes', () => {
  let ctx: Awaited<ReturnType<typeof build>>;
  const http = () => request(ctx.app.getHttpServer());

  beforeEach(async () => {
    ctx = await build();
  });
  afterEach(async () => {
    await ctx.app.close();
  });

  it('reject non-admins with 403', async () => {
    const base = `/admin/instructors/${INSTRUCTOR_ID}/photo`;
    const as = 'Bearer jwt-instructor';
    await http().delete(`${base}/2`).set('Authorization', as).expect(403);
    await http()
      .post(`${base}/confirm`)
      .set('Authorization', as)
      .send({ contentType: 'image/png', slot: 2 })
      .expect(403);
    expect(ctx.repo.versions).toEqual({ 1: 0, 2: 0, 3: 0 });
  });

  it('return 404 for an unknown instructor', async () => {
    await http()
      .delete(`/admin/instructors/${UNKNOWN_ID}/photo/3`)
      .set('Authorization', 'Bearer jwt-admin')
      .expect(404);
  });
});
