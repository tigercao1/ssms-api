import type { ConfigService } from '@nestjs/config';
import type { AuditEntry } from '../../src/audit/audit.types';
import type { GoogleConnectionRow } from '../../src/google/google.types';
import {
  GoogleConnectionRepository,
  type SaveGoogleConnectionInput,
} from '../../src/google/google-connection.repository';
import type { GoogleRuntime } from '../../src/google/google-runtime';

export const TEST_ENC_KEY = Buffer.alloc(32, 7).toString('base64');
export const TEST_CLIENT_ID = 'client-123.apps.googleusercontent.com';
export const TEST_CLIENT_SECRET = 'test-client-secret';

export const GOOGLE_ENV: Record<string, string> = {
  GOOGLE_CLIENT_ID: TEST_CLIENT_ID,
  GOOGLE_CLIENT_SECRET: TEST_CLIENT_SECRET,
  GOOGLE_TOKEN_ENC_KEY: TEST_ENC_KEY,
};

export function configFrom(
  env: Record<string, string | undefined>,
): ConfigService {
  return {
    get: (key: string) => env[key],
  } as unknown as ConfigService;
}

export class InMemoryGoogleConnectionRepository extends GoogleConnectionRepository {
  row: GoogleConnectionRow | null = null;
  failSave = false;

  get(): Promise<GoogleConnectionRow | null> {
    return Promise.resolve(this.row ? { ...this.row } : null);
  }

  save(input: SaveGoogleConnectionInput): Promise<GoogleConnectionRow> {
    if (this.failSave) {
      return Promise.reject(new Error('db down'));
    }
    this.row = {
      account_email: input.accountEmail,
      refresh_token_enc: input.refreshTokenEnc,
      scopes: input.scopes,
      connected_at: input.connectedAt,
      connected_by: input.connectedBy,
      last_refresh_at: input.connectedAt,
      last_error: null,
      last_error_at: null,
    };
    return Promise.resolve({ ...this.row });
  }

  recordRefresh(at: string): Promise<void> {
    if (this.row) {
      this.row = {
        ...this.row,
        last_refresh_at: at,
        last_error: null,
        last_error_at: null,
      };
    }
    return Promise.resolve();
  }

  recordError(
    message: string,
    at: string,
    options: { clearToken?: boolean } = {},
  ): Promise<void> {
    if (this.row) {
      this.row = {
        ...this.row,
        last_error: message,
        last_error_at: at,
        refresh_token_enc: options.clearToken
          ? null
          : this.row.refresh_token_enc,
      };
    }
    return Promise.resolve();
  }

  delete(): Promise<void> {
    this.row = null;
    return Promise.resolve();
  }
}

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

export type FakeHandler = (call: RecordedCall) => Response | Promise<Response>;

export function json(body: unknown, status = 200, headers = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

export function fakeGoogleRuntime(handler: FakeHandler) {
  const calls: RecordedCall[] = [];
  const sleeps: number[] = [];
  let clock = Date.parse('2026-10-11T12:00:00.000Z');
  const runtime: GoogleRuntime = {
    fetch: jest.fn((input: string | URL, init?: RequestInit) => {
      const call: RecordedCall = {
        url: input.toString(),
        method: init?.method ?? 'GET',
        headers: { ...(init?.headers as Record<string, string>) },
        body: typeof init?.body === 'string' ? init.body : undefined,
      };
      calls.push(call);
      return Promise.resolve(handler(call));
    }),
    now: () => clock,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  };
  return {
    runtime,
    calls,
    sleeps,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

export function idToken(claims: Record<string, unknown>): string {
  const part = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'RS256' })}.${part(claims)}.signature`;
}

export function recordingAudit() {
  const entries: AuditEntry[] = [];
  return {
    entries,
    record: jest.fn((entry: AuditEntry) => {
      entries.push(entry);
      return Promise.resolve();
    }),
  };
}
