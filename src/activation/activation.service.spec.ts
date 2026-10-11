import {
  HttpException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import type { InviteRecipient, InviteRow } from './activation.types';
import { ActivationService, normalizeEmail } from './activation.service';
import type { InviteDispatcher } from './invite-dispatcher';
import { hashInviteToken } from './invite-token';
import type { InvitesRepository } from './invites.repository';

const NOW = new Date('2026-10-11T04:00:00Z');
const TOKEN = 'A'.repeat(43);

function row(overrides: Partial<InviteRecipient> = {}): InviteRecipient {
  return {
    id: 'inv-1',
    instructor_id: 'ins-1',
    auth_user_id: 'auth-1',
    email: 'jane@example.test',
    token_hash: hashInviteToken(TOKEN),
    season: '2026/27',
    expires_at: '2026-11-01T00:00:00Z',
    send_claimed_at: null,
    sent_at: '2026-10-02T00:00:00Z',
    remind_claimed_at: null,
    reminded_at: null,
    redeemed_at: null,
    activated_at: null,
    created_at: '2026-10-01T00:00:00Z',
    display_name_en: 'Jane',
    preferred_language: 'zh-CN',
    ...overrides,
  };
}

function setup() {
  const invites = {
    findByTokenHash: jest.fn<Promise<InviteRow | null>, [string]>(),
    findLatestByEmail: jest.fn<Promise<InviteRecipient | null>, [string]>(),
    markRedeemed: jest.fn().mockResolvedValue(undefined),
    markActivated: jest.fn().mockResolvedValue(undefined),
  };
  const auth = {
    findEmail: jest.fn().mockResolvedValue('Jane@Example.test'),
    magicLinkTokenHash: jest.fn().mockResolvedValue('hashed-otp'),
  };
  const dispatcher = { dispatch: jest.fn().mockResolvedValue('sent') };
  const service = new ActivationService(
    invites as unknown as InvitesRepository,
    auth,
    dispatcher as unknown as InviteDispatcher,
  );
  return { service, invites, auth, dispatcher };
}

beforeEach(() => {
  jest.useFakeTimers({ now: NOW });
});

afterEach(() => {
  jest.useRealTimers();
});

describe('normalizeEmail', () => {
  it('trims and lowercases', () => {
    expect(normalizeEmail('  Jane@Example.TEST ')).toBe('jane@example.test');
  });
});

describe('ActivationService.redeem', () => {
  it('returns the current email and a magic-link token hash, stamping redeemed_at once', async () => {
    const { service, invites, auth } = setup();
    invites.findByTokenHash.mockResolvedValue(row());
    await expect(service.redeem(TOKEN)).resolves.toEqual({
      email: 'Jane@Example.test',
      tokenHash: 'hashed-otp',
    });
    expect(invites.findByTokenHash).toHaveBeenCalledWith(
      hashInviteToken(TOKEN),
    );
    expect(auth.findEmail).toHaveBeenCalledWith('auth-1');
    expect(auth.magicLinkTokenHash).toHaveBeenCalledWith('Jane@Example.test');
    expect(invites.markRedeemed).toHaveBeenCalledWith('inv-1', NOW);
  });

  it('does not touch redeemed_at on later uses', async () => {
    const { service, invites } = setup();
    invites.findByTokenHash.mockResolvedValue(
      row({ redeemed_at: '2026-10-05T00:00:00Z' }),
    );
    await expect(service.redeem(TOKEN)).resolves.toMatchObject({
      tokenHash: 'hashed-otp',
    });
    expect(invites.markRedeemed).not.toHaveBeenCalled();
  });

  it('404s an unknown token', async () => {
    const { service, invites } = setup();
    invites.findByTokenHash.mockResolvedValue(null);
    await expect(service.redeem(TOKEN)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('404s a malformed token without a lookup', async () => {
    const { service, invites } = setup();
    await expect(service.redeem('short')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(invites.findByTokenHash).not.toHaveBeenCalled();
  });

  it('410s an expired invite with its email', async () => {
    const { service, invites, auth } = setup();
    invites.findByTokenHash.mockResolvedValue(
      row({ expires_at: '2026-10-11T03:59:59Z' }),
    );
    const err = (await service
      .redeem(TOKEN)
      .catch((e: unknown) => e)) as HttpException;
    expect(err).toBeInstanceOf(HttpException);
    expect(err.getStatus()).toBe(410);
    expect(err.getResponse()).toEqual({ email: 'jane@example.test' });
    expect(auth.magicLinkTokenHash).not.toHaveBeenCalled();
    expect(invites.markRedeemed).not.toHaveBeenCalled();
  });

  it('404s when the auth user is gone', async () => {
    const { service, invites, auth } = setup();
    invites.findByTokenHash.mockResolvedValue(row());
    auth.findEmail.mockResolvedValue(null);
    await expect(service.redeem(TOKEN)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(auth.magicLinkTokenHash).not.toHaveBeenCalled();
  });

  it('does not stamp redeemed_at when link generation fails', async () => {
    const { service, invites, auth } = setup();
    invites.findByTokenHash.mockResolvedValue(row());
    auth.magicLinkTokenHash.mockRejectedValue(
      new InternalServerErrorException('x'),
    );
    await expect(service.redeem(TOKEN)).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
    expect(invites.markRedeemed).not.toHaveBeenCalled();
  });
});

describe('ActivationService.resend', () => {
  it('re-issues an expired invite', async () => {
    const { service, invites, dispatcher } = setup();
    const invite = row({
      expires_at: '2026-10-01T00:00:00Z',
      activated_at: '2026-10-03T00:00:00Z',
    });
    invites.findLatestByEmail.mockResolvedValue(invite);
    await service.resend(' Jane@Example.TEST ');
    expect(invites.findLatestByEmail).toHaveBeenCalledWith('jane@example.test');
    expect(dispatcher.dispatch).toHaveBeenCalledWith(
      invite,
      'invite.season',
      'background',
      NOW,
    );
  });

  it('re-issues a valid invite whose account is not activated yet', async () => {
    const { service, invites, dispatcher } = setup();
    invites.findLatestByEmail.mockResolvedValue(row());
    await service.resend('jane@example.test');
    expect(dispatcher.dispatch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['no invite', null],
    ['never sent', row({ sent_at: null, token_hash: null, expires_at: null })],
    [
      'activated and still valid',
      row({ activated_at: '2026-10-03T00:00:00Z' }),
    ],
  ])('does nothing when %s', async (_label, invite) => {
    const { service, invites, dispatcher } = setup();
    invites.findLatestByEmail.mockResolvedValue(invite);
    await service.resend('jane@example.test');
    expect(dispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('logs a send that did not go out', async () => {
    const { service, invites, dispatcher } = setup();
    invites.findLatestByEmail.mockResolvedValue(row());
    dispatcher.dispatch.mockResolvedValue('skipped');
    await expect(service.resend('jane@example.test')).resolves.toBeUndefined();
  });

  it('resendInBackground swallows errors', async () => {
    const { service, invites } = setup();
    invites.findLatestByEmail.mockRejectedValueOnce(new Error('db down'));
    expect(service.resendInBackground('jane@example.test')).toBeUndefined();
    invites.findLatestByEmail.mockRejectedValueOnce('weird');
    service.resendInBackground('jane@example.test');
    await jest.runAllTimersAsync();
    expect(invites.findLatestByEmail).toHaveBeenCalledTimes(2);
  });
});

describe('ActivationService.complete', () => {
  it('stamps activated_at for the caller', async () => {
    const { service, invites } = setup();
    await service.complete('auth-1');
    expect(invites.markActivated).toHaveBeenCalledWith('auth-1', NOW);
  });
});
