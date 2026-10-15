import {
  type CanActivate,
  type ExecutionContext,
  Global,
  type INestApplication,
  Module,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import type { Request } from 'express';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AuditService } from '../audit/audit.service';
import { EmailVerifiedGuard } from '../auth/email-verified.guard';
import { DocumentOnboardingService } from '../documents/document-onboarding.service';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { SUPABASE_CLIENT } from '../database/supabase-client.token';
import { ActivationAuth } from './activation-auth';
import { ActivationModule } from './activation.module';
import type { InviteRecipient, InviteRow } from './activation.types';
import { InviteDispatcher } from './invite-dispatcher';
import { hashInviteToken } from './invite-token';
import { InvitesRepository } from './invites.repository';

const TOKEN = 'b'.repeat(43);
const EXPIRED_TOKEN = 'c'.repeat(43);

@Global()
@Module({
  providers: [
    { provide: SUPABASE_CLIENT, useValue: {} },
    { provide: AuditService, useValue: {} },
  ],
  exports: [SUPABASE_CLIENT, AuditService],
})
class FakeDatabaseModule {}

class FakeJwtGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    if (req.headers.authorization !== 'Bearer good') {
      throw new UnauthorizedException();
    }
    (req as Request & { user: unknown }).user = { sub: 'auth-1' };
    return true;
  }
}

function invite(overrides: Partial<InviteRecipient> = {}): InviteRecipient {
  return {
    id: 'inv-1',
    instructor_id: 'ins-1',
    auth_user_id: 'auth-1',
    email: 'jane@example.test',
    token_hash: hashInviteToken(TOKEN),
    season: '2026/27',
    expires_at: '2999-01-01T00:00:00Z',
    send_claimed_at: null,
    sent_at: '2026-10-01T00:00:00Z',
    remind_claimed_at: null,
    reminded_at: null,
    redeemed_at: null,
    activated_at: null,
    created_at: '2026-10-01T00:00:00Z',
    display_name_en: 'Jane',
    preferred_language: 'zh-CN',
    ...overrides,
  };
}

describe('Activation HTTP', () => {
  let app: INestApplication<App>;
  const invites = {
    findByTokenHash: jest.fn((hash: string): Promise<InviteRow | null> => {
      if (hash === hashInviteToken(TOKEN)) return Promise.resolve(invite());
      if (hash === hashInviteToken(EXPIRED_TOKEN))
        return Promise.resolve(invite({ expires_at: '2020-01-01T00:00:00Z' }));
      return Promise.resolve(null);
    }),
    findLatestByEmail: jest.fn((email: string) =>
      Promise.resolve(email === 'jane@example.test' ? invite() : null),
    ),
    markRedeemed: jest.fn().mockResolvedValue(undefined),
    markActivated: jest.fn().mockResolvedValue(undefined),
    findLatestByAuthUser: jest.fn(
      (): Promise<InviteRow | null> => Promise.resolve(invite()),
    ),
  };
  const onboarding = {
    assignPublished: jest.fn().mockResolvedValue({ created: 2, skipped: 0 }),
    assignPublishedForAuthUser: jest.fn().mockResolvedValue(null),
  };
  const auth = {
    findEmail: jest.fn().mockResolvedValue('jane@example.test'),
    magicLinkTokenHash: jest.fn().mockResolvedValue('otp-hash'),
  };
  const dispatcher = { dispatch: jest.fn().mockResolvedValue('sent') };

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        FakeDatabaseModule,
        ThrottlerModule.forRoot([{ ttl: 60_000, limit: 60 }]),
        ActivationModule,
      ],
    })
      .overrideProvider(InvitesRepository)
      .useValue(invites)
      .overrideProvider(ActivationAuth)
      .useValue(auth)
      .overrideProvider(InviteDispatcher)
      .useValue(dispatcher)
      .overrideProvider(DocumentOnboardingService)
      .useValue(onboarding)
      .overrideGuard(SupabaseAuthGuard)
      .useClass(FakeJwtGuard)
      .overrideGuard(EmailVerifiedGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.listen(0, '127.0.0.1');
  });

  afterEach(async () => {
    await app.close();
  });

  const redeem = (token: unknown, ip = '1.1.1.1') =>
    request(app.getHttpServer())
      .post('/activation/redeem')
      .set('Fly-Client-IP', ip)
      .send({ token });
  const resend = (email: unknown, ip = '2.2.2.2') =>
    request(app.getHttpServer())
      .post('/activation/resend')
      .set('Fly-Client-IP', ip)
      .send({ email });

  describe('POST /activation/redeem', () => {
    it('200 { email, tokenHash } and stamps redeemed_at', async () => {
      const res = await redeem(TOKEN).expect(200);
      expect(res.body).toEqual({
        email: 'jane@example.test',
        tokenHash: 'otp-hash',
      });
      expect(invites.markRedeemed).toHaveBeenCalledWith(
        'inv-1',
        expect.any(Date),
      );
    });

    it('410 { email } for an expired invite', async () => {
      const res = await redeem(EXPIRED_TOKEN).expect(410);
      expect(res.body).toEqual({ email: 'jane@example.test' });
    });

    it('404 without a token when the account email changed after the invite', async () => {
      auth.findEmail.mockResolvedValueOnce('new-address@example.test');
      const res = await redeem(TOKEN).expect(404);
      expect(res.body).not.toHaveProperty('email');
      expect(res.body).not.toHaveProperty('tokenHash');
      expect(auth.magicLinkTokenHash).not.toHaveBeenCalled();
    });

    it('404 for an unknown token', async () => {
      const res = await redeem('d'.repeat(43)).expect(404);
      expect(res.body).not.toHaveProperty('email');
    });

    it('400 for a missing token', async () => {
      await redeem(undefined).expect(400);
    });

    it('429 after 10 requests a minute from one IP, other IPs unaffected', async () => {
      for (let i = 0; i < 10; i++) {
        await redeem('d'.repeat(43), '9.9.9.9').expect(404);
      }
      await redeem(TOKEN, '9.9.9.9').expect(429);
      await redeem(TOKEN, '8.8.8.8').expect(200);
    });
  });

  describe('POST /activation/resend', () => {
    it('202 with the same body for a known and an unknown email', async () => {
      const known = await resend('Jane@Example.test', '3.3.3.1').expect(202);
      const unknown = await resend('nobody@example.test', '3.3.3.2').expect(
        202,
      );
      expect(known.body).toEqual({ status: 'accepted' });
      expect(unknown.body).toEqual(known.body);
      await new Promise((resolve) => setImmediate(resolve));
      expect(dispatcher.dispatch).toHaveBeenCalledTimes(1);
      expect(dispatcher.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'inv-1' }),
        'invite.season',
        'background',
        expect.any(Date),
      );
    });

    it('400 for a malformed email', async () => {
      await resend('nope').expect(400);
    });

    it('429 after 3 requests an hour from one IP', async () => {
      for (let i = 0; i < 3; i++) {
        await resend(`u${i}@example.test`, '4.4.4.4').expect(202);
      }
      await resend('u9@example.test', '4.4.4.4').expect(429);
    });

    it('429 after 3 requests an hour for one email across IPs', async () => {
      for (let i = 0; i < 3; i++) {
        await resend('same@example.test', `5.5.5.${i}`).expect(202);
      }
      await resend('SAME@example.test', '5.5.5.9').expect(429);
      await resend('other@example.test', '5.5.5.9').expect(202);
    });
  });

  describe('POST /me/activation/complete', () => {
    it('204, stamps activated_at and assigns onboarding documents for the invite season', async () => {
      await request(app.getHttpServer())
        .post('/me/activation/complete')
        .set('Authorization', 'Bearer good')
        .expect(204);
      expect(invites.markActivated).toHaveBeenCalledWith(
        'auth-1',
        expect.any(Date),
      );
      expect(onboarding.assignPublished).toHaveBeenCalledWith('ins-1');
    });

    it('204 even when auto-assign finds nothing to assign', async () => {
      invites.findLatestByAuthUser.mockResolvedValueOnce(null);
      await request(app.getHttpServer())
        .post('/me/activation/complete')
        .set('Authorization', 'Bearer good')
        .expect(204);
      expect(onboarding.assignPublishedForAuthUser).toHaveBeenCalledWith(
        'auth-1',
      );
    });

    it('401 without a session', async () => {
      await request(app.getHttpServer())
        .post('/me/activation/complete')
        .expect(401);
      expect(invites.markActivated).not.toHaveBeenCalled();
      expect(onboarding.assignPublished).not.toHaveBeenCalled();
    });
  });
});
