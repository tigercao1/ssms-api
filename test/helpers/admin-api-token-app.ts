import { generateKeyPairSync } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  Controller,
  Get,
  Global,
  type INestApplication,
  Module,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { sign } from 'jsonwebtoken';
import type { App } from 'supertest/types';
import { AdminApiTokensModule } from '../../src/admin-api-tokens/admin-api-tokens.module';
import { AdminApiTokensRepository } from '../../src/admin-api-tokens/admin-api-tokens.repository';
import { ADMIN_API_TOKEN_CLOCK } from '../../src/admin-api-tokens/admin-api-tokens.types';
import { AdminController } from '../../src/admin/admin.controller';
import { AdminRepository } from '../../src/admin/admin.repository';
import { AdminService } from '../../src/admin/admin.service';
import { AuditService } from '../../src/audit/audit.service';
import { AuthModule } from '../../src/auth/auth.module';
import { CurrentUser } from '../../src/auth/current-user.decorator';
import type { SupabaseJwtPayload } from '../../src/auth/jwt-payload.interface';
import { SupabaseAuthGuard } from '../../src/auth/supabase-auth.guard';
import { BIO_TRANSLATOR } from '../../src/bio-translation/bio-translator.interface';
import { SUPABASE_CLIENT } from '../../src/database/supabase-client.token';
import { DocumentOnboardingService } from '../../src/documents/document-onboarding.service';
import { InstructorsService } from '../../src/instructors/instructors.service';
import { MailerService } from '../../src/mailer/mailer.service';
import { SeasonsService } from '../../src/seasons/seasons.service';
import { GoLiveService } from '../../src/shopify-sync/go-live.service';
import { FakeClock, InMemoryAdminApiTokens } from './admin-api-tokens-fakes';
import { recordingAudit } from './public-pages-fakes';

export const ADMIN = '7d0f8a1e-5b2c-4e3d-9a8b-1c2d3e4f5a6b';
export const OTHER_ADMIN = '8e1f9b2f-6c3d-4f4e-8b9c-2d3e4f5a6b7c';
export const MINUTE = 60_000;
export const DAY = 24 * 60 * MINUTE;

export interface FakeAuthUser {
  id: string;
  email: string;
  email_confirmed_at: string;
  app_metadata: { role?: string };
  banned_until?: string;
}

@Controller('me/probe')
@UseGuards(SupabaseAuthGuard)
class MeProbeController {
  @Get()
  get(@CurrentUser() user: SupabaseJwtPayload): { sub: string } {
    return { sub: user.sub };
  }
}

export async function startAdminApiTokenApp() {
  const clock = new FakeClock();
  const repo = new InMemoryAdminApiTokens(clock);
  const audit = recordingAudit();
  const users = new Map<string, FakeAuthUser>();
  const ownerLookups: string[] = [];
  const owners = { failing: false };
  const setUserRole = jest.fn().mockResolvedValue(undefined);
  const { privateKey, publicKey } = generateKeyPairSync('ec', {
    namedCurve: 'P-256',
  });
  const jwksBody = JSON.stringify({
    keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'k', alg: 'ES256' }],
  });
  const jwks = createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(jwksBody);
  });
  await new Promise<void>((resolve) => jwks.listen(0, '127.0.0.1', resolve));
  const { port } = jwks.address() as AddressInfo;

  const supabase = {
    rpc: jest.fn().mockResolvedValue({ data: true, error: null }),
    auth: {
      admin: {
        getUserById: (id: string) => {
          ownerLookups.push(id);
          if (owners.failing) {
            return Promise.resolve({
              data: { user: null },
              error: { status: 500, message: 'down' },
            });
          }
          const user = users.get(id);
          return Promise.resolve(
            user
              ? { data: { user }, error: null }
              : { data: { user: null }, error: { status: 404, message: 'nf' } },
          );
        },
      },
    },
  };

  @Global()
  @Module({
    providers: [
      { provide: SUPABASE_CLIENT, useValue: supabase },
      { provide: AuditService, useValue: audit },
    ],
    exports: [SUPABASE_CLIENT, AuditService],
  })
  class FakeInfraModule {}

  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        ignoreEnvFile: true,
        load: [
          () => ({
            SUPABASE_URL: 'http://localhost',
            SUPABASE_JWKS_URL: `http://127.0.0.1:${port}/jwks.json`,
          }),
        ],
      }),
      FakeInfraModule,
      AuthModule,
      AdminApiTokensModule,
    ],
    controllers: [AdminController, MeProbeController],
    providers: [
      AdminService,
      { provide: SeasonsService, useValue: {} },
      {
        provide: AdminRepository,
        useValue: {
          listAllInstructors: () => Promise.resolve([]),
          listInstructorIdsAtLocation: () => Promise.resolve(new Set()),
          getUserRole: () =>
            Promise.resolve({ found: true, role: 'instructor' }),
          setUserRole,
        },
      },
      {
        provide: GoLiveService,
        useValue: {
          stages: () => Promise.resolve(new Map()),
          summaries: () => Promise.resolve(new Map()),
        },
      },
      { provide: InstructorsService, useValue: {} },
      { provide: MailerService, useValue: {} },
      { provide: DocumentOnboardingService, useValue: {} },
      { provide: BIO_TRANSLATOR, useValue: {} },
    ],
  })
    .overrideProvider(AdminApiTokensRepository)
    .useValue(repo)
    .overrideProvider(ADMIN_API_TOKEN_CLOCK)
    .useValue(clock)
    .compile();
  const app = moduleRef.createNestApplication<INestApplication<App>>();
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  await app.listen(0, '127.0.0.1');

  const addAdmin = (id: string) =>
    users.set(id, {
      id,
      email: `${id.slice(0, 4)}@example.com`,
      email_confirmed_at: '2026-01-01T00:00:00Z',
      app_metadata: { role: 'admin' },
    });

  return {
    app,
    clock,
    repo,
    audit,
    users,
    ownerLookups,
    owners,
    setUserRole,
    addAdmin,
    reset(): void {
      clock.advance(DAY);
      users.clear();
      addAdmin(ADMIN);
      addAdmin(OTHER_ADMIN);
      audit.entries.length = 0;
      ownerLookups.length = 0;
      owners.failing = false;
      setUserRole.mockClear();
    },
    sessionJwt(sub = ADMIN): string {
      return `Bearer ${sign(
        {
          sub,
          aud: 'authenticated',
          session_id: 'live',
          app_metadata: { role: 'admin' },
        },
        privateKey,
        { algorithm: 'ES256', keyid: 'k', expiresIn: 300 },
      )}`;
    },
    async close(): Promise<void> {
      await app.close();
      await new Promise((resolve) => jwks.close(resolve));
    },
  };
}

export type AdminApiTokenApp = Awaited<
  ReturnType<typeof startAdminApiTokenApp>
>;
