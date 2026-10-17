import {
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
  UnauthorizedException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Request } from 'express';
import type { Server } from 'node:http';
import request from 'supertest';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { BIO_TRANSLATOR } from '../bio-translation/bio-translator.interface';
import { MailerService } from '../mailer/mailer.service';
import { BioDraftService } from './bio-draft.service';
import { InstructorsController } from './instructors.controller';
import { InstructorsRepository } from './instructors.repository';
import { InstructorsService } from './instructors.service';
import type { InstructorRow } from './instructors.types';
import { TRANSLATION_QUEUE } from './translation-queue.port';

class FakeJwtGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const match = /^Bearer (verified|unverified)-(\S+)$/.exec(
      req.headers.authorization ?? '',
    );
    if (!match) {
      throw new UnauthorizedException();
    }
    (req as Request & { user: unknown }).user = {
      sub: match[2],
      email: `${match[2]}@example.test`,
      ...(match[1] === 'verified'
        ? { email_confirmed_at: '2026-10-01T00:00:00Z' }
        : {}),
    };
    return true;
  }
}

function fakeRepo() {
  const instructors = new Map<string, string>([
    ['auth-connected', 'inst-connected'],
    ['auth-unlinked', 'inst-unlinked'],
  ]);
  const calendars = new Set(['inst-connected']);
  return {
    findByAuthUserId: jest.fn((authUserId: string) => {
      const id = instructors.get(authUserId);
      return Promise.resolve(id ? ({ id } as InstructorRow) : null);
    }),
    hasCalendar: jest.fn((instructorId: string) =>
      Promise.resolve(calendars.has(instructorId)),
    ),
    insertPending: jest.fn(),
  };
}

describe('GET /me/instructor/calendar (HTTP)', () => {
  let app: INestApplication;
  let repo: ReturnType<typeof fakeRepo>;
  const http = () => request(app.getHttpServer() as Server);

  beforeEach(async () => {
    repo = fakeRepo();
    const moduleRef = await Test.createTestingModule({
      controllers: [InstructorsController],
      providers: [
        InstructorsService,
        { provide: InstructorsRepository, useValue: repo },
        { provide: BioDraftService, useValue: {} },
        { provide: TRANSLATION_QUEUE, useValue: {} },
        { provide: MailerService, useValue: {} },
        { provide: BIO_TRANSLATOR, useValue: {} },
      ],
    })
      .overrideGuard(SupabaseAuthGuard)
      .useClass(FakeJwtGuard)
      .compile();
    app = moduleRef.createNestApplication<INestApplication>();
    await app.listen(0, '127.0.0.1');
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns connected: true when an admin linked a calendar', async () => {
    const res = await http()
      .get('/me/instructor/calendar')
      .set('Authorization', 'Bearer verified-auth-connected')
      .expect(200);
    expect(res.body).toEqual({ connected: true });
  });

  it('returns connected: false without a linked calendar', async () => {
    const res = await http()
      .get('/me/instructor/calendar')
      .set('Authorization', 'Bearer verified-auth-unlinked')
      .expect(200);
    expect(res.body).toEqual({ connected: false });
  });

  it('returns connected: false and creates no row for a caller without an instructor row', async () => {
    const res = await http()
      .get('/me/instructor/calendar')
      .set('Authorization', 'Bearer verified-auth-new')
      .expect(200);
    expect(res.body).toEqual({ connected: false });
    expect(repo.insertPending).not.toHaveBeenCalled();
    expect(repo.hasCalendar).not.toHaveBeenCalled();
  });

  it('answers 401 without a token', async () => {
    await http().get('/me/instructor/calendar').expect(401);
    expect(repo.findByAuthUserId).not.toHaveBeenCalled();
  });

  it.each(['/me/instructor', '/me/instructor/calendar'])(
    'GET %s answers 403 for an unverified email',
    async (path) => {
      await http()
        .get(path)
        .set('Authorization', 'Bearer unverified-auth-connected')
        .expect(403);
      expect(repo.findByAuthUserId).not.toHaveBeenCalled();
    },
  );
});
