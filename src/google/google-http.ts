import type { GoogleRuntime } from './google-runtime';

export const MAX_GOOGLE_ATTEMPTS = 4;
export const GOOGLE_BACKOFF_BASE_MS = 500;
export const GOOGLE_MAX_BACKOFF_MS = 8_000;
export const GOOGLE_REQUEST_TIMEOUT_MS = 15_000;

const RATE_LIMIT_REASONS = new Set([
  'rateLimitExceeded',
  'userRateLimitExceeded',
]);

export interface GoogleErrorBody {
  error?:
    | string
    | {
        code?: number;
        message?: string;
        errors?: { reason?: string; message?: string }[];
      };
  error_description?: string;
}

export async function readErrorBody(res: Response): Promise<GoogleErrorBody> {
  try {
    return (await res.json()) as GoogleErrorBody;
  } catch {
    return {};
  }
}

export function errorReason(body: GoogleErrorBody): string | undefined {
  return typeof body.error === 'object'
    ? body.error.errors?.[0]?.reason
    : body.error;
}

export function errorMessage(body: GoogleErrorBody): string {
  if (typeof body.error === 'object') {
    return body.error.message ?? '';
  }
  return body.error_description ?? '';
}

async function isRetryable(res: Response): Promise<boolean> {
  if (res.status === 429 || res.status >= 500) {
    return true;
  }
  if (res.status !== 403) {
    return false;
  }
  const reason = errorReason(await readErrorBody(res.clone()));
  return reason !== undefined && RATE_LIMIT_REASONS.has(reason);
}

export function backoffMs(attempt: number, retryAfter: string | null): number {
  const seconds = retryAfter === null ? NaN : Number(retryAfter);
  const wait = Number.isFinite(seconds)
    ? seconds * 1000
    : GOOGLE_BACKOFF_BASE_MS * 2 ** (attempt - 1);
  return Math.min(Math.max(wait, 0), GOOGLE_MAX_BACKOFF_MS);
}

export interface SendResult {
  response: Response;
  attempts: number;
}

export async function sendWithRetry(
  runtime: GoogleRuntime,
  url: string,
  init: () => RequestInit,
): Promise<SendResult> {
  for (let attempt = 1; ; attempt++) {
    let response: Response;
    try {
      response = await runtime.fetch(url, {
        ...init(),
        signal: AbortSignal.timeout(GOOGLE_REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      if (attempt >= MAX_GOOGLE_ATTEMPTS) {
        throw err;
      }
      await runtime.sleep(backoffMs(attempt, null));
      continue;
    }
    if (attempt < MAX_GOOGLE_ATTEMPTS && (await isRetryable(response))) {
      await runtime.sleep(
        backoffMs(attempt, response.headers.get('retry-after')),
      );
      continue;
    }
    return { response, attempts: attempt };
  }
}
