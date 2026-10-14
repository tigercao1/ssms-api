import {
  Global,
  type INestApplication,
  Module,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Webhook } from 'standardwebhooks';
import request from 'supertest';
import { SUPABASE_CLIENT } from '../database/supabase-client.token';
import { InstructorsRepository } from '../instructors/instructors.repository';
import type { InstructorRow } from '../instructors/instructors.types';
import { EMAIL_SENDER } from '../mailer/email-sender.interface';
import type { EmailMessage } from '../mailer/mailer.types';
import { AuthHooksModule } from './auth-hooks.module';
import { HOOK_RATE_LIMIT } from './hook-throttler.guard';
import { EMAIL_SEND_FAILED } from './send-email-hook.service';

const SECRET_B64 = randomBytes(32).toString('base64');
const HOOK_SECRET = `v1,whsec_${SECRET_B64}`;
const PATH = '/hooks/auth/send-email';
const USER_ID = '8484b834-f29e-4af2-bf42-80644d154f76';

const supabaseStub = {
  from: () => ({ insert: () => Promise.resolve({ error: null }) }),
};

@Global()
@Module({
  providers: [{ provide: SUPABASE_CLIENT, useValue: supabaseStub }],
  exports: [SUPABASE_CLIENT],
})
class FakeDatabaseModule {}

function hookPayload(
  emailData: Record<string, unknown>,
  user: Record<string, unknown> = {},
) {
  return {
    user: {
      id: USER_ID,
      aud: 'authenticated',
      role: 'authenticated',
      email: 'lin@example.com',
      phone: '',
      app_metadata: { provider: 'email', providers: ['email'] },
      user_metadata: { email: 'lin@example.com', email_verified: false },
      identities: [],
      created_at: '2026-10-01T00:00:00Z',
      updated_at: '2026-10-01T00:00:00Z',
      is_anonymous: false,
      ...user,
    },
    email_data: {
      token: '305805',
      token_hash: 'pkce_7d5b7b1964cf5d388340a7f04f1dbb5e',
      redirect_to: 'https://app.ssnow.club/update-password',
      email_action_type: 'recovery',
      site_url: 'https://app.ssnow.club',
      token_new: '',
      token_hash_new: '',
      old_email: '',
      old_phone: '',
      provider: '',
      factor_type: '',
      ...emailData,
    },
  };
}

function sign(body: string, at: Date = new Date(), secret = SECRET_B64) {
  const id = `msg_${randomBytes(8).toString('hex')}`;
  return {
    'webhook-id': id,
    'webhook-timestamp': String(Math.floor(at.getTime() / 1000)),
    'webhook-signature': new Webhook(secret).sign(id, at, body),
  };
}

interface Harness {
  app: INestApplication;
  server: string;
  sent: EmailMessage[];
  sender: { send: jest.Mock; isConfigured: () => boolean };
}

async function createApp(
  options: { secret?: string; row?: Partial<InstructorRow> | null } = {},
): Promise<Harness> {
  const sent: EmailMessage[] = [];
  const sender = {
    isConfigured: () => true,
    send: jest.fn((message: EmailMessage) => {
      sent.push(message);
      return Promise.resolve({ id: `re_${sent.length}` });
    }),
  };
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        ignoreEnvFile: true,
        load: [
          () =>
            options.secret === undefined
              ? {}
              : { SEND_EMAIL_HOOK_SECRET: options.secret },
        ],
      }),
      FakeDatabaseModule,
      AuthHooksModule,
    ],
  })
    .overrideProvider(EMAIL_SENDER)
    .useValue(sender)
    .overrideProvider(InstructorsRepository)
    .useValue({
      findByAuthUserId: () => Promise.resolve(options.row ?? null),
    })
    .compile();
  const app = moduleRef.createNestApplication({ rawBody: true });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  await app.listen(0);
  const address = (app.getHttpServer() as Server).address() as AddressInfo;
  return {
    app,
    server: `http://127.0.0.1:${address.port}`,
    sent,
    sender,
  };
}

function post(server: string, body: string, headers: Record<string, string>) {
  return request(server)
    .post(PATH)
    .set('Content-Type', 'application/json')
    .set(headers)
    .send(body);
}

describe('POST /hooks/auth/send-email (HTTP)', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await createApp({ secret: HOOK_SECRET });
  });

  afterEach(async () => {
    await h.app.close();
  });

  it('sends the recovery email for a correctly signed payload and returns 200 {}', async () => {
    const body = JSON.stringify(hookPayload({}));
    const res = await post(h.server, body, sign(body));

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body).toEqual({});
    expect(h.sent).toHaveLength(1);
    const [message] = h.sent;
    expect(message.to).toBe('lin@example.com');
    expect(message.subject).toContain(' / ');
    const verify =
      `${process.env.SUPABASE_URL}/auth/v1/verify?token=pkce_7d5b7b1964cf5d388340a7f04f1dbb5e` +
      `&type=recovery&redirect_to=${encodeURIComponent('https://app.ssnow.club/update-password')}`;
    expect(message.text).toContain(verify);
    expect(message.html).toContain(verify.replace(/&/g, '&amp;'));
    expect(`${message.html}${message.text}`).not.toContain('305805');
  });

  it('sends both secure email-change emails', async () => {
    const body = JSON.stringify(
      hookPayload(
        {
          email_action_type: 'email_change',
          token_hash: 'hash-for-new',
          token_new: '222222',
          token_hash_new: 'hash-for-current',
        },
        { new_email: 'lin.new@example.com' },
      ),
    );
    const res = await post(h.server, body, sign(body));

    expect(res.status).toBe(200);
    const byTo = Object.fromEntries(h.sent.map((m) => [m.to, m.text]));
    expect(byTo['lin@example.com']).toContain('token=hash-for-current');
    expect(byTo['lin.new@example.com']).toContain('token=hash-for-new');
  });

  it('renders in the instructor preferred language', async () => {
    await h.app.close();
    h = await createApp({
      secret: HOOK_SECRET,
      row: { id: 'instr-1', preferred_language: 'zh-CN' },
    });
    const body = JSON.stringify(
      hookPayload({ email_action_type: 'reauthentication' }),
    );
    const res = await post(h.server, body, sign(body));

    expect(res.status).toBe(200);
    expect(h.sent[0].subject).toBe('您的 SSnow 验证码');
    expect(h.sent[0].text).toContain('305805');
  });

  it('rejects an unsigned request with 401 in the hook error format', async () => {
    const body = JSON.stringify(hookPayload({}));
    const res = await post(h.server, body, {});

    expect(res.status).toBe(401);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body).toEqual({
      error: { http_code: 401, message: 'Invalid webhook signature' },
    });
    expect(h.sent).toHaveLength(0);
  });

  it('rejects a body that was changed after signing', async () => {
    const body = JSON.stringify(hookPayload({}));
    const tampered = JSON.stringify(
      hookPayload({}, { email: 'attacker@example.com' }),
    );
    const res = await post(h.server, tampered, sign(body));

    expect(res.status).toBe(401);
    expect(h.sent).toHaveLength(0);
  });

  it('rejects a signature from another secret', async () => {
    const body = JSON.stringify(hookPayload({}));
    const other = randomBytes(32).toString('base64');
    const res = await post(h.server, body, sign(body, new Date(), other));

    expect(res.status).toBe(401);
  });

  it('rejects a stale timestamp', async () => {
    const body = JSON.stringify(hookPayload({}));
    const res = await post(
      h.server,
      body,
      sign(body, new Date(Date.now() - 10 * 60 * 1000)),
    );

    expect(res.status).toBe(401);
    expect(h.sent).toHaveLength(0);
  });

  it('answers 400 in the hook error format for a signed but malformed payload', async () => {
    const body = JSON.stringify({ user: { id: USER_ID } });
    const res = await post(h.server, body, sign(body));

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: {
        http_code: 400,
        message: 'Payload must contain user and email_data',
      },
    });
  });

  it('answers 500 in the hook error format when delivery fails', async () => {
    h.sender.send.mockRejectedValue(new Error('resend down'));
    const body = JSON.stringify(hookPayload({}));
    const res = await post(h.server, body, sign(body));

    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error: { http_code: 500, message: EMAIL_SEND_FAILED },
    });
  });

  it('throttles a client past the per-minute limit', async () => {
    const body = JSON.stringify(hookPayload({}));
    for (let i = 0; i < HOOK_RATE_LIMIT.limit; i++) {
      await post(h.server, body, { 'Fly-Client-IP': '203.0.113.9' });
    }
    const limited = await post(h.server, body, {
      'Fly-Client-IP': '203.0.113.9',
    });
    expect(limited.status).toBe(429);
    expect((limited.body as { error: { http_code: number } }).error).toEqual(
      expect.objectContaining({ http_code: 429 }),
    );
    expect(limited.headers['retry-after']).toBeDefined();

    const otherClient = await post(h.server, body, sign(body));
    expect(otherClient.status).toBe(200);
  });
});

describe('POST /hooks/auth/send-email without SEND_EMAIL_HOOK_SECRET', () => {
  it('refuses every call with 503', async () => {
    const h = await createApp({});
    const body = JSON.stringify(hookPayload({}));
    const res = await post(h.server, body, sign(body));

    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      error: { http_code: 503, message: 'Send email hook is not configured' },
    });
    expect(h.sent).toHaveLength(0);
    await h.app.close();
  });
});
