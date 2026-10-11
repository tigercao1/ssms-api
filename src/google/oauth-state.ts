import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

interface StatePayload {
  sub: string;
  exp: number;
  n: string;
}

function sign(body: string, secret: string): string {
  return createHmac('sha256', secret)
    .update(`google-oauth-state.${body}`)
    .digest('base64url');
}

export function signOAuthState(
  userId: string,
  secret: string,
  now: number,
  ttlMs = OAUTH_STATE_TTL_MS,
): string {
  const payload: StatePayload = {
    sub: userId,
    exp: now + ttlMs,
    n: randomBytes(12).toString('base64url'),
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${sign(body, secret)}`;
}

export function verifyOAuthState(
  state: string | undefined,
  secret: string,
  now: number,
): { userId: string } | null {
  const [body, signature, ...rest] = (state ?? '').split('.');
  if (!body || !signature || rest.length > 0) {
    return null;
  }
  const expected = Buffer.from(sign(body, secret));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return null;
  }
  let payload: Partial<StatePayload>;
  try {
    payload = JSON.parse(
      Buffer.from(body, 'base64url').toString('utf8'),
    ) as Partial<StatePayload>;
  } catch {
    return null;
  }
  if (
    typeof payload.sub !== 'string' ||
    payload.sub === '' ||
    typeof payload.exp !== 'number' ||
    now >= payload.exp
  ) {
    return null;
  }
  return { userId: payload.sub };
}
