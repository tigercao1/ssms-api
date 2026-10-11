import type { SendEmailRequest, SendOutcome } from '../mailer/mailer.types';
import { InviteDispatcher } from './invite-dispatcher';
import { hashInviteToken } from './invite-token';
import type { InviteRecipient } from './activation.types';
import type { InvitesRepository } from './invites.repository';

const NOW = new Date('2026-10-11T04:00:00Z');

function invite(overrides: Partial<InviteRecipient> = {}): InviteRecipient {
  return {
    id: 'inv-1',
    instructor_id: 'ins-1',
    auth_user_id: 'auth-1',
    email: 'jane@example.test',
    token_hash: null,
    season: '2026/27',
    expires_at: null,
    send_claimed_at: null,
    sent_at: null,
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

describe('InviteDispatcher', () => {
  function setup() {
    const invites = { setToken: jest.fn().mockResolvedValue(undefined) };
    const mailer = {
      send: jest
        .fn<Promise<SendOutcome>, [SendEmailRequest<'invite.season'>]>()
        .mockResolvedValue('sent'),
      portalLink: jest.fn((p: string) => `https://portal.test${p}`),
    };
    const dispatcher = new InviteDispatcher(
      invites as unknown as InvitesRepository,
      mailer,
    );
    return { invites, mailer, dispatcher };
  }

  it('stores only the hash of a fresh token and emails the link to it', async () => {
    const { invites, mailer, dispatcher } = setup();
    await expect(
      dispatcher.dispatch(invite(), 'invite.season', 'sync', NOW),
    ).resolves.toBe('sent');

    const [id, tokenHash, expiresAt] = invites.setToken.mock.calls[0] as [
      string,
      string,
      Date,
    ];
    expect(id).toBe('inv-1');
    expect(expiresAt.toISOString()).toBe('2026-11-10T04:00:00.000Z');
    const request = mailer.send.mock.calls[0][0];
    const token = new URL(request.vars.activateUrl).searchParams.get(
      't',
    ) as string;
    expect(hashInviteToken(token)).toBe(tokenHash);
    expect(request).toEqual({
      template: 'invite.season',
      to: 'jane@example.test',
      language: 'zh-CN',
      vars: {
        displayName: 'Jane',
        season: '2026/27',
        activateUrl: `https://portal.test/activate?t=${token}`,
        validDays: 30,
      },
      mode: 'sync',
      instructorId: 'ins-1',
      authUserId: 'auth-1',
      metadata: { inviteId: 'inv-1', season: '2026/27' },
    });
    expect(JSON.stringify(request.metadata)).not.toContain(token);
  });

  it('omits a blank name and goes bilingual without a language', async () => {
    const { mailer, dispatcher } = setup();
    await dispatcher.dispatch(
      invite({ display_name_en: '', preferred_language: null }),
      'invite.reminder',
      'background',
    );
    expect(mailer.send.mock.calls[0][0]).toMatchObject({
      template: 'invite.reminder',
      language: 'bilingual',
      vars: { displayName: undefined },
      mode: 'background',
    });
  });

  it('passes an idempotency key through to the mailer', async () => {
    const { mailer, dispatcher } = setup();
    await dispatcher.dispatch(
      invite(),
      'invite.season',
      'sync',
      NOW,
      'invite-inv-1-sent-2026-10-11T04:00:00.000Z',
    );
    expect(mailer.send.mock.calls[0][0].idempotencyKey).toBe(
      'invite-inv-1-sent-2026-10-11T04:00:00.000Z',
    );
  });

  it('does not email when the token cannot be stored', async () => {
    const { invites, mailer, dispatcher } = setup();
    invites.setToken.mockRejectedValue(new Error('db'));
    await expect(
      dispatcher.dispatch(invite(), 'invite.season', 'sync'),
    ).rejects.toThrow('db');
    expect(mailer.send).not.toHaveBeenCalled();
  });
});
