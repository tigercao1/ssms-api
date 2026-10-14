import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import {
  Controller,
  Get,
  Global,
  type INestApplication,
  Module,
  ServiceUnavailableException,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { sign } from 'jsonwebtoken';
import request from 'supertest';
import type { App } from 'supertest/types';
import { SUPABASE_CLIENT } from '../database/supabase-client.token';
import { AuthModule } from './auth.module';
import { CurrentUser } from './current-user.decorator';
import type { SupabaseJwtPayload } from './jwt-payload.interface';
import { SessionLivenessService } from './session-liveness.service';
import { SupabaseAuthGuard } from './supabase-auth.guard';
import { SupabaseJwtStrategy } from './supabase-jwt.strategy';

const SESSION = '0b8f7a62-3c4d-4e5f-8a9b-0c1d2e3f4a5b';

describe('SupabaseJwtStrategy.validate', () => {
  const config = new ConfigService({ SUPABASE_URL: 'http://localhost' });

  function strategy(isActive: jest.Mock): SupabaseJwtStrategy {
    return new SupabaseJwtStrategy(config, {
      isActive,
    } as unknown as SessionLivenessService);
  }

  it('rejects a token without a session_id claim', async () => {
    const isActive = jest.fn();

    await expect(strategy(isActive).validate({ sub: 'u1' })).rejects.toThrow(
      UnauthorizedException,
    );
    expect(isActive).not.toHaveBeenCalled();
  });

  it('rejects a token whose session is no longer active', async () => {
    const isActive = jest.fn().mockResolvedValue(false);

    await expect(
      strategy(isActive).validate({ sub: 'u1', session_id: SESSION }),
    ).rejects.toThrow(UnauthorizedException);
    expect(isActive).toHaveBeenCalledWith(SESSION);
  });

  it('returns the payload when the session is active', async () => {
    const isActive = jest.fn().mockResolvedValue(true);
    const payload = { sub: 'u1', session_id: SESSION };

    await expect(strategy(isActive).validate(payload)).resolves.toBe(payload);
  });

  it('propagates a 503 from the session check', async () => {
    const isActive = jest
      .fn()
      .mockRejectedValue(new ServiceUnavailableException());

    await expect(
      strategy(isActive).validate({ sub: 'u1', session_id: SESSION }),
    ).rejects.toThrow(ServiceUnavailableException);
  });
});

@Controller('probe')
class ProbeController {
  @UseGuards(SupabaseAuthGuard)
  @Get()
  get(@CurrentUser() user: SupabaseJwtPayload): { sub: string } {
    return { sub: user.sub };
  }
}

describe('SupabaseAuthGuard with a real ES256 token', () => {
  const KID = 'test-key';
  let privateKey: KeyObject;
  let jwks: Server;
  let app: INestApplication<App>;
  const rpc = jest.fn();

  function token(claims: Record<string, unknown>): string {
    return sign({ sub: 'u1', aud: 'authenticated', ...claims }, privateKey, {
      algorithm: 'ES256',
      keyid: KID,
      expiresIn: 300,
    });
  }

  beforeAll(async () => {
    const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    privateKey = pair.privateKey;
    const body = JSON.stringify({
      keys: [
        {
          ...pair.publicKey.export({ format: 'jwk' }),
          kid: KID,
          alg: 'ES256',
          use: 'sig',
        },
      ],
    });
    jwks = createServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(body);
    });
    await new Promise<void>((resolve) => jwks.listen(0, '127.0.0.1', resolve));
    const { port } = jwks.address() as AddressInfo;

    @Global()
    @Module({
      providers: [{ provide: SUPABASE_CLIENT, useValue: { rpc } }],
      exports: [SUPABASE_CLIENT],
    })
    class FakeDatabaseModule {}

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
        FakeDatabaseModule,
        AuthModule,
      ],
      controllers: [ProbeController],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.listen(0, '127.0.0.1');
  });

  afterAll(async () => {
    await app.close();
    await new Promise((resolve) => jwks.close(resolve));
  });

  beforeEach(() => rpc.mockReset());

  it('accepts a token whose session is active', async () => {
    rpc.mockResolvedValue({ data: true, error: null });

    await request(app.getHttpServer())
      .get('/probe')
      .set('Authorization', `Bearer ${token({ session_id: 'live' })}`)
      .expect(200, { sub: 'u1' });
    expect(rpc).toHaveBeenCalledWith('session_is_active', {
      p_session_id: 'live',
    });
  });

  it('rejects a token whose session was revoked with 401', async () => {
    rpc.mockResolvedValue({ data: false, error: null });

    await request(app.getHttpServer())
      .get('/probe')
      .set('Authorization', `Bearer ${token({ session_id: 'revoked' })}`)
      .expect(401);
  });

  it('answers 503, not 401, when the session check fails', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'down' } });

    await request(app.getHttpServer())
      .get('/probe')
      .set('Authorization', `Bearer ${token({ session_id: 'blip' })}`)
      .expect(503);
  });
});
