import { createHash, randomBytes } from 'node:crypto';

export const INVITE_VALID_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface IssuedInviteToken {
  token: string;
  tokenHash: string;
  expiresAt: Date;
}

/** sha256 hex of an invite token; the only form ever stored. */
export function hashInviteToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** A fresh 32-byte base64url token, its hash and its expiry (30 days from `now`). */
export function issueInviteToken(now: Date = new Date()): IssuedInviteToken {
  const token = randomBytes(32).toString('base64url');
  return {
    token,
    tokenHash: hashInviteToken(token),
    expiresAt: new Date(now.getTime() + INVITE_VALID_DAYS * DAY_MS),
  };
}

/** True when the invite has no expiry yet (never sent) or it has passed. */
export function isInviteExpired(
  expiresAt: string | null,
  now: Date = new Date(),
): boolean {
  return expiresAt === null || new Date(expiresAt).getTime() <= now.getTime();
}

/** The portal path an invite email links to. */
export function activationPath(token: string): string {
  return `/activate?t=${encodeURIComponent(token)}`;
}
