import {
  HttpException,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { ActivationAuth } from './activation-auth';
import type { InviteRecipient, InviteRow } from './activation.types';
import {
  ActivationService,
  hashEmail,
  normalizeEmail,
} from './activation.service';
import {
  InMemoryInvitesRepository,
  InMemoryResendCooldownRepository,
} from '../../test/helpers/reminders-fakes';
import { InviteDispatcher } from './invite-dispatcher';
import { hashInviteToken } from './invite-token';
import type { InvitesRepository } from './invites.repository';
import type { DocumentOnboardingService } from '../documents/document-onboarding.service';

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
    findLatestByAuthUser: jest
      .fn<Promise<InviteRow | null>, [string]>()
      .mockResolvedValue(null),
  };
  const auth = {
    findEmail: jest.fn().mockResolvedValue('Jane@Example.test'),
    magicLinkTokenHash: jest.fn().mockResolvedValue('hashed-otp'),
  };
  const dispatcher = { resend: jest.fn().mockResolvedValue('sent') };
  const onboarding = {
    assignPublished: jest.fn().mockResolvedValue({ created: 1, skipped: 0 }),
    assignPublishedForAuthUser: jest.fn().mockResolvedValue(null),
  };
  const cooldowns = new InMemoryResendCooldownRepository();
  const service = new ActivationService(
    invites as unknown as InvitesRepository,
    auth,
    dispatcher as unknown as InviteDispatcher,
    onboarding as unknown as DocumentOnboardingService,
    cooldowns,
  );
  return { service, invites, auth, dispatcher, onboarding, cooldowns };
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
  it('returns the invite email and a magic-link token hash, stamping redeemed_at once', async () => {
    const { service, invites, auth } = setup();
    invites.findByTokenHash.mockResolvedValue(row());
    await expect(service.redeem(TOKEN)).resolves.toEqual({
      email: 'jane@example.test',
      tokenHash: 'hashed-otp',
    });
    expect(invites.findByTokenHash).toHaveBeenCalledWith(
      hashInviteToken(TOKEN),
    );
    expect(auth.findEmail).toHaveBeenCalledWith('auth-1');
    expect(auth.magicLinkTokenHash).toHaveBeenCalledWith('jane@example.test');
    expect(invites.markRedeemed).toHaveBeenCalledWith('inv-1', NOW);
  });

  it('404s without issuing a token when the auth email no longer matches the invite', async () => {
    const { service, invites, auth } = setup();
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    invites.findByTokenHash.mockResolvedValue(row());
    auth.findEmail.mockResolvedValue(' Someone.Else@Example.test ');
    await expect(service.redeem(TOKEN)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(auth.magicLinkTokenHash).not.toHaveBeenCalled();
    expect(invites.markRedeemed).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    const [message] = warn.mock.calls[0] as [string];
    expect(message).toContain('inv-1');
    expect(message).not.toMatch(/example\.test/i);
    warn.mockRestore();
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

  const expiredRedeem = async (service: ActivationService) => {
    const err = (await service
      .redeem(TOKEN)
      .catch((e: unknown) => e)) as HttpException;
    expect(err).toBeInstanceOf(HttpException);
    expect(err.getStatus()).toBe(410);
    return err.getResponse();
  };

  it('410s an expired invite with its email and no resend wait', async () => {
    const { service, invites, auth } = setup();
    invites.findByTokenHash.mockResolvedValue(
      row({ expires_at: '2026-10-11T03:59:59Z' }),
    );
    await expect(expiredRedeem(service)).resolves.toEqual({
      email: 'jane@example.test',
      retryAfterSeconds: 0,
    });
    expect(auth.magicLinkTokenHash).not.toHaveBeenCalled();
    expect(invites.markRedeemed).not.toHaveBeenCalled();
  });

  it('410s with the seconds left before that email may ask for a new link', async () => {
    const { service, invites } = setup();
    invites.findByTokenHash.mockResolvedValue(
      row({ expires_at: '2026-10-11T03:59:59Z' }),
    );
    await service.requestResend('Jane@Example.test');
    jest.advanceTimersByTime(15_000);
    await expect(expiredRedeem(service)).resolves.toEqual({
      email: 'jane@example.test',
      retryAfterSeconds: 45,
    });
  });

  it('still 410s, with no wait, when the cooldown cannot be read', async () => {
    const { service, invites, cooldowns } = setup();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
    jest
      .spyOn(cooldowns, 'retryAfterSeconds')
      .mockRejectedValueOnce(new Error('db down'));
    invites.findByTokenHash.mockResolvedValue(
      row({ expires_at: '2026-10-11T03:59:59Z' }),
    );
    await expect(expiredRedeem(service)).resolves.toEqual({
      email: 'jane@example.test',
      retryAfterSeconds: 0,
    });
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
    expect(dispatcher.resend).toHaveBeenCalledWith(invite, NOW);
  });

  it('re-issues a valid invite whose account is not activated yet', async () => {
    const { service, invites, dispatcher } = setup();
    invites.findLatestByEmail.mockResolvedValue(row());
    await service.resend('jane@example.test');
    expect(dispatcher.resend).toHaveBeenCalledTimes(1);
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
    expect(dispatcher.resend).not.toHaveBeenCalled();
  });

  it.each(['skipped', 'cooling_down'])(
    'resolves quietly when the resend was %s',
    async (outcome) => {
      const { service, invites, dispatcher } = setup();
      invites.findLatestByEmail.mockResolvedValue(row());
      dispatcher.resend.mockResolvedValue(outcome);
      await expect(
        service.resend('jane@example.test'),
      ).resolves.toBeUndefined();
    },
  );

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

function setupWithInvite() {
  const invites = new InMemoryInvitesRepository();
  invites.seed({
    email: 'jane@example.test',
    sent_at: '2026-10-01T00:00:00Z',
    expires_at: '2026-10-05T00:00:00Z',
  });
  const mailer = {
    send: jest.fn().mockResolvedValue('sent'),
    portalLink: (p: string) => `https://portal.test${p}`,
  };
  const cooldowns = new InMemoryResendCooldownRepository();
  const service = new ActivationService(
    invites,
    {} as ActivationAuth,
    new InviteDispatcher(invites, mailer),
    {} as DocumentOnboardingService,
    cooldowns,
  );
  return { service, mailer, cooldowns };
}

describe('ActivationService.requestResend', () => {
  const settle = () => jest.advanceTimersByTimeAsync(0);

  it('answers an invited and an uninvited email the same way', async () => {
    const { service, mailer } = setupWithInvite();
    const invited = await service.requestResend('jane@example.test');
    const uninvited = await service.requestResend('nobody@example.test');
    expect(invited).toEqual({ status: 'accepted', retryAfterSeconds: 60 });
    expect(uninvited).toEqual(invited);
    await settle();
    expect(mailer.send).toHaveBeenCalledTimes(1);
  });

  it('counts down inside the window without extending it, then accepts again', async () => {
    const { service, mailer } = setupWithInvite();
    await expect(service.requestResend('jane@example.test')).resolves.toEqual({
      status: 'accepted',
      retryAfterSeconds: 60,
    });
    await settle();
    jest.advanceTimersByTime(1_000);
    await expect(
      service.requestResend('jane@example.test'),
    ).resolves.toMatchObject({ retryAfterSeconds: 59 });
    jest.advanceTimersByTime(29_500);
    await expect(
      service.requestResend('jane@example.test'),
    ).resolves.toMatchObject({ retryAfterSeconds: 30 });
    await settle();
    expect(mailer.send).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(29_500);
    await expect(service.requestResend('jane@example.test')).resolves.toEqual({
      status: 'accepted',
      retryAfterSeconds: 60,
    });
    await settle();
    expect(mailer.send).toHaveBeenCalledTimes(2);
  });

  it('shares one window across case and whitespace variants of an email', async () => {
    const { service } = setupWithInvite();
    await service.requestResend('jane@example.test');
    jest.advanceTimersByTime(10_000);
    await expect(
      service.requestResend('  JANE@Example.TEST '),
    ).resolves.toMatchObject({ retryAfterSeconds: 50 });
  });

  it('sends once for a burst of simultaneous requests', async () => {
    const { service, mailer } = setupWithInvite();
    const answers = await Promise.all(
      Array.from({ length: 5 }, () =>
        service.requestResend('jane@example.test'),
      ),
    );
    expect(answers.map((a) => a.retryAfterSeconds)).toEqual([
      60, 60, 60, 60, 60,
    ]);
    await settle();
    expect(mailer.send).toHaveBeenCalledTimes(1);
  });

  it('keeps only a sha256 of the normalised email', async () => {
    const { service, cooldowns } = setupWithInvite();
    await service.requestResend(' Jane@Example.test ');
    expect([...cooldowns.lastRequestedAt.keys()]).toEqual([
      hashEmail('jane@example.test'),
    ]);
    expect(hashEmail('jane@example.test')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('ActivationService.resend cooldown', () => {
  const setup = setupWithInvite;

  it('emails once for a burst of resends, and again a minute later', async () => {
    const { service, mailer } = setup();
    await Promise.all([
      service.resend('jane@example.test'),
      service.resend('Jane@Example.test'),
    ]);
    await service.resend('jane@example.test');
    jest.advanceTimersByTime(59_000);
    await service.resend('jane@example.test');
    expect(mailer.send).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(1_000);
    await service.resend('jane@example.test');
    expect(mailer.send).toHaveBeenCalledTimes(2);
  });
});

describe('ActivationService.complete', () => {
  it('stamps activated_at for the caller', async () => {
    const { service, invites } = setup();
    await service.complete('auth-1');
    expect(invites.markActivated).toHaveBeenCalledWith('auth-1', NOW);
  });

  it("assigns onboarding documents to the invite's instructor", async () => {
    const { service, invites, onboarding } = setup();
    invites.findLatestByAuthUser.mockResolvedValueOnce(row());
    await service.complete('auth-1');
    expect(invites.findLatestByAuthUser).toHaveBeenCalledWith('auth-1');
    expect(onboarding.assignPublished).toHaveBeenCalledWith('ins-1');
    expect(onboarding.assignPublishedForAuthUser).not.toHaveBeenCalled();
  });

  it('falls back to the caller without an invite', async () => {
    const { service, onboarding } = setup();
    await service.complete('auth-1');
    expect(onboarding.assignPublishedForAuthUser).toHaveBeenCalledWith(
      'auth-1',
    );
    expect(onboarding.assignPublished).not.toHaveBeenCalled();
  });

  it('still assigns, from the caller, when the invite lookup fails', async () => {
    const { service, invites, onboarding } = setup();
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    invites.findLatestByAuthUser.mockRejectedValueOnce(new Error('db down'));
    await expect(service.complete('auth-1')).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('db down'));
    expect(onboarding.assignPublishedForAuthUser).toHaveBeenCalledWith(
      'auth-1',
    );
  });
});
