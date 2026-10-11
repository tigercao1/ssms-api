import { createHash } from 'node:crypto';
import {
  INVITE_VALID_DAYS,
  activationPath,
  hashInviteToken,
  isInviteExpired,
  issueInviteToken,
} from './invite-token';

describe('invite tokens', () => {
  it('issues a 32-byte base64url token and stores only its sha256 hex', () => {
    const now = new Date('2026-10-11T00:00:00Z');
    const issued = issueInviteToken(now);
    expect(issued.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(issued.token, 'base64url')).toHaveLength(32);
    expect(issued.tokenHash).toBe(
      createHash('sha256').update(issued.token).digest('hex'),
    );
    expect(issued.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(issued.tokenHash).not.toContain(issued.token);
    expect(issued.expiresAt.toISOString()).toBe('2026-11-10T00:00:00.000Z');
    expect(INVITE_VALID_DAYS).toBe(30);
  });

  it('issues a different token every time', () => {
    expect(issueInviteToken().token).not.toBe(issueInviteToken().token);
  });

  it('hashes deterministically', () => {
    expect(hashInviteToken('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('treats a missing or past expiry as expired', () => {
    const now = new Date('2026-10-11T12:00:00Z');
    expect(isInviteExpired(null, now)).toBe(true);
    expect(isInviteExpired('2026-10-11T12:00:00Z', now)).toBe(true);
    expect(isInviteExpired('2026-10-11T11:59:59Z', now)).toBe(true);
    expect(isInviteExpired('2026-10-11T12:00:01Z', now)).toBe(false);
    expect(isInviteExpired('2999-01-01T00:00:00Z')).toBe(false);
  });

  it('builds the portal activation path', () => {
    expect(activationPath('a-b_c')).toBe('/activate?t=a-b_c');
  });
});
