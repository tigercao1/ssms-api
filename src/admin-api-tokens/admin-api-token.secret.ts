import { createHash, randomBytes } from 'crypto';
import { API_TOKEN_PREFIX } from '../auth/api-token-authenticator';

const SECRET_BYTES = 32;
const WELL_FORMED = /^ssms_pat_[A-Za-z0-9_-]{43}$/;

export interface AdminApiTokenSecret {
  token: string;
  hash: string;
  prefix: string;
  last4: string;
}

export function hashAdminApiToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function isWellFormedAdminApiToken(token: string): boolean {
  return WELL_FORMED.test(token);
}

export function newAdminApiTokenSecret(): AdminApiTokenSecret {
  const secret = randomBytes(SECRET_BYTES).toString('base64url');
  const token = `${API_TOKEN_PREFIX}${secret}`;
  return {
    token,
    hash: hashAdminApiToken(token),
    prefix: `${API_TOKEN_PREFIX}${secret.slice(0, 4)}`,
    last4: secret.slice(-4),
  };
}
