import { GoogleNotConfiguredError } from './google.errors';

export const GOOGLE_CALENDAR_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.events.freebusy',
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
] as const;

export const GOOGLE_IDENTITY_SCOPES = ['openid', 'email'] as const;

export const DEFAULT_GOOGLE_OAUTH_REDIRECT_URI =
  'https://ssms-api-vivid-brook-6788.fly.dev/admin/google/oauth/callback';
export const DEFAULT_GOOGLE_ALLOWED_ACCOUNT = 'admin@ssnow.club';
export const DEFAULT_GOOGLE_OAUTH_RETURN_URL =
  'https://app.ssnow.club/admin/settings/google';

export const GOOGLE_TOKEN_ENC_KEY_BYTES = 32;

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  encKey: Buffer;
  redirectUri: string;
  allowedAccount: string;
  hostedDomain: string;
  returnUrl: string;
}

type EnvGetter = (key: string) => string | undefined;

function decodeKey(raw: string | undefined): Buffer | undefined {
  if (!raw || !/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) {
    return undefined;
  }
  const key = Buffer.from(raw, 'base64');
  return key.length === GOOGLE_TOKEN_ENC_KEY_BYTES ? key : undefined;
}

export function readGoogleConfig(get: EnvGetter): GoogleConfig {
  const value = (key: string) => get(key)?.trim() || undefined;
  const clientId = value('GOOGLE_CLIENT_ID');
  const clientSecret = value('GOOGLE_CLIENT_SECRET');
  const encKey = decodeKey(value('GOOGLE_TOKEN_ENC_KEY'));
  const missing = [
    ['GOOGLE_CLIENT_ID', clientId],
    ['GOOGLE_CLIENT_SECRET', clientSecret],
    ['GOOGLE_TOKEN_ENC_KEY', encKey],
  ]
    .filter(([, v]) => v === undefined)
    .map(([key]) => key as string);
  if (!clientId || !clientSecret || !encKey) {
    throw new GoogleNotConfiguredError(missing);
  }
  const allowedAccount = (
    value('GOOGLE_ALLOWED_ACCOUNT') ?? DEFAULT_GOOGLE_ALLOWED_ACCOUNT
  ).toLowerCase();
  return {
    clientId,
    clientSecret,
    encKey,
    redirectUri:
      value('GOOGLE_OAUTH_REDIRECT_URI') ?? DEFAULT_GOOGLE_OAUTH_REDIRECT_URI,
    allowedAccount,
    hostedDomain: allowedAccount.split('@')[1] ?? '',
    returnUrl:
      value('GOOGLE_OAUTH_RETURN_URL') ?? DEFAULT_GOOGLE_OAUTH_RETURN_URL,
  };
}
