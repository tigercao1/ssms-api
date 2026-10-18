import {
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { InstructorsRepository } from '../instructors/instructors.repository';
import type { InstructorRow } from '../instructors/instructors.types';
import type { MailerService } from '../mailer/mailer.service';
import {
  EmailDeliveryError,
  type SendEmailRequest,
} from '../mailer/mailer.types';
import {
  EMAIL_SEND_FAILED,
  SendEmailHookService,
} from './send-email-hook.service';
import {
  parseSendEmailHookPayload,
  type SendEmailHookPayload,
} from './send-email-hook.types';

const SUPABASE_URL = 'https://proj.supabase.co';
const REDIRECT = 'https://app.ssnow.club/update-password';
const USER_ID = '8484b834-f29e-4af2-bf42-80644d154f76';

function payload(
  emailData: Record<string, unknown>,
  user: Record<string, unknown> = {},
): SendEmailHookPayload {
  return parseSendEmailHookPayload({
    user: { id: USER_ID, email: 'lin@example.com', ...user },
    email_data: {
      token: '305805',
      token_hash: 'hash-current',
      redirect_to: REDIRECT,
      site_url: 'https://app.ssnow.club',
      token_new: '',
      token_hash_new: '',
      ...emailData,
    },
  });
}

function link(tokenHash: string, type: string, redirect = REDIRECT): string {
  return `${SUPABASE_URL}/auth/v1/verify?token=${tokenHash}&type=${type}&redirect_to=${encodeURIComponent(redirect)}`;
}

function setup(
  options: {
    row?: Partial<InstructorRow> | null;
    lookup?: () => Promise<InstructorRow | null>;
    send?: jest.Mock;
  } = {},
) {
  const send = options.send ?? jest.fn().mockResolvedValue('sent');
  const findByAuthUserId = jest.fn(
    options.lookup ??
      (() => Promise.resolve((options.row ?? null) as InstructorRow | null)),
  );
  const service = new SendEmailHookService(
    { send } as unknown as MailerService,
    { findByAuthUserId } as unknown as InstructorsRepository,
    {
      get: (key: string) =>
        key === 'SUPABASE_URL' ? `${SUPABASE_URL}/` : undefined,
    } as unknown as ConfigService,
  );
  const sent = () =>
    send.mock.calls.map(([request]) => request as SendEmailRequest);
  return { service, send, sent, findByAuthUserId };
}

describe('SendEmailHookService', () => {
  describe.each([
    ['signup', 'auth.confirm_signup', 'confirmUrl'],
    ['recovery', 'auth.recovery', 'resetUrl'],
    ['magiclink', 'auth.magic_link', 'signInUrl'],
    ['email', 'auth.magic_link', 'signInUrl'],
    ['invite', 'auth.invite', 'acceptUrl'],
  ])('%s', (type, template, urlVar) => {
    it(`sends ${template} with a verify link and no code`, async () => {
      const { service, sent } = setup();
      await service.handle(payload({ email_action_type: type }));

      expect(sent()).toHaveLength(1);
      const [request] = sent();
      expect(request).toMatchObject({
        template,
        to: 'lin@example.com',
        mode: 'sync',
        authUserId: USER_ID,
        language: 'bilingual',
        instructorId: null,
        metadata: { email_action_type: type },
      });
      expect(request.vars).toEqual({ [urlVar]: link('hash-current', type) });
      expect(JSON.stringify(request.vars)).not.toContain('305805');
    });
  });

  it('reauthentication sends the code only', async () => {
    const { service, sent } = setup();
    await service.handle(payload({ email_action_type: 'reauthentication' }));
    expect(sent()).toEqual([
      expect.objectContaining({
        template: 'auth.reauthentication',
        to: 'lin@example.com',
        vars: { code: '305805' },
      }),
    ]);
  });

  it('reauthentication without a token is a bad request', () => {
    const { service } = setup();
    expect(() =>
      service.plan(
        payload({ email_action_type: 'reauthentication', token: '' }),
      ),
    ).toThrow(BadRequestException);
  });

  it('secure email_change sends two emails with the swapped hash pairing', async () => {
    const { service, sent } = setup();
    await service.handle(
      payload(
        {
          email_action_type: 'email_change',
          token: '111111',
          token_hash: 'hash-for-new-address',
          token_new: '222222',
          token_hash_new: 'hash-for-current-address',
        },
        { new_email: 'lin.new@example.com' },
      ),
    );

    const byRecipient = Object.fromEntries(sent().map((r) => [r.to, r]));
    expect(Object.keys(byRecipient).sort()).toEqual([
      'lin.new@example.com',
      'lin@example.com',
    ]);
    expect(byRecipient['lin@example.com']).toMatchObject({
      template: 'auth.email_change',
      vars: {
        confirmUrl: link('hash-for-current-address', 'email_change'),
        newEmail: 'lin.new@example.com',
      },
    });
    expect(byRecipient['lin.new@example.com']).toMatchObject({
      template: 'auth.email_change',
      vars: {
        confirmUrl: link('hash-for-new-address', 'email_change'),
        newEmail: 'lin.new@example.com',
      },
    });
    expect(JSON.stringify(sent())).not.toMatch(/111111|222222/);
  });

  it('non-secure email_change sends one email to the new address with token_hash', async () => {
    const { service, sent } = setup();
    await service.handle(
      payload(
        { email_action_type: 'email_change', token_hash: 'hash-new' },
        { new_email: 'lin.new@example.com' },
      ),
    );
    expect(sent()).toEqual([
      expect.objectContaining({
        template: 'auth.email_change',
        to: 'lin.new@example.com',
        vars: {
          confirmUrl: link('hash-new', 'email_change'),
          newEmail: 'lin.new@example.com',
        },
      }),
    ]);
  });

  it('secure email_change without a new address is a bad request', () => {
    const { service } = setup();
    expect(() =>
      service.plan(
        payload({
          email_action_type: 'email_change',
          token_hash_new: 'hash-cur',
        }),
      ),
    ).toThrow(BadRequestException);
  });

  it.each([
    ['password_changed_notification', 'auth.password_changed', {}, {}],
    ['phone_changed_notification', 'auth.phone_changed', {}, {}],
    [
      'identity_linked_notification',
      'auth.identity_linked',
      { provider: 'google' },
      { provider: 'google' },
    ],
    [
      'identity_unlinked_notification',
      'auth.identity_unlinked',
      {},
      { provider: 'unknown' },
    ],
    [
      'mfa_factor_enrolled_notification',
      'auth.mfa_enrolled',
      { factor_type: 'totp' },
      { factorType: 'totp' },
    ],
    [
      'mfa_factor_unenrolled_notification',
      'auth.mfa_unenrolled',
      {},
      { factorType: 'unknown' },
    ],
  ])('%s → %s', async (type, template, extra, vars) => {
    const { service, sent } = setup();
    await service.handle(
      payload({ email_action_type: type, token: '', token_hash: '', ...extra }),
    );
    expect(sent()).toEqual([
      expect.objectContaining({ template, to: 'lin@example.com', vars }),
    ]);
  });

  it('email_changed_notification goes to the old address', async () => {
    const { service, sent } = setup();
    await service.handle(
      payload(
        {
          email_action_type: 'email_changed_notification',
          old_email: 'lin.old@example.com',
        },
        { email: 'lin@example.com' },
      ),
    );
    expect(sent()).toEqual([
      expect.objectContaining({
        template: 'auth.email_changed',
        to: 'lin.old@example.com',
        vars: { oldEmail: 'lin.old@example.com', newEmail: 'lin@example.com' },
      }),
    ]);
  });

  it('unknown types fall back to the bilingual generic email with a link', async () => {
    const { service, sent } = setup({ row: { preferred_language: 'en' } });
    await service.handle(payload({ email_action_type: 'brand_new_type' }));
    expect(sent()).toEqual([
      expect.objectContaining({
        template: 'auth.generic',
        language: 'bilingual',
        vars: { actionUrl: link('hash-current', 'brand_new_type') },
      }),
    ]);
  });

  it('unknown types without a token hash send the generic email without a link', async () => {
    const { service, sent } = setup();
    await service.handle(
      payload({ email_action_type: 'brand_new_type', token_hash: '' }),
    );
    expect(sent()[0].vars).toEqual({ actionUrl: null });
  });

  it('omits redirect_to from the link when the payload has none', () => {
    const { service } = setup();
    const [email] = service.plan(
      payload({ email_action_type: 'signup', redirect_to: '' }),
    );
    expect(email.vars).toEqual({
      confirmUrl: `${SUPABASE_URL}/auth/v1/verify?token=hash-current&type=signup`,
    });
  });

  it('requires a token hash for link emails', () => {
    const { service } = setup();
    expect(() =>
      service.plan(payload({ email_action_type: 'signup', token_hash: '' })),
    ).toThrow(BadRequestException);
  });

  it('rejects a payload with no recipient address', () => {
    const { service } = setup();
    expect(() =>
      service.plan(payload({ email_action_type: 'signup' }, { email: '' })),
    ).toThrow(BadRequestException);
  });

  describe('language', () => {
    it.each([
      ['en', 'en'],
      ['zh-CN', 'zh-CN'],
      ['fr', 'bilingual'],
    ])(
      'uses the instructor row preferred_language %s → %s',
      async (pref, expected) => {
        const { service, sent, findByAuthUserId } = setup({
          row: { id: 'instr-1', preferred_language: pref as 'en' },
        });
        await service.handle(payload({ email_action_type: 'recovery' }));
        expect(findByAuthUserId).toHaveBeenCalledWith(USER_ID);
        expect(sent()[0]).toMatchObject({
          language: expected,
          instructorId: 'instr-1',
        });
      },
    );

    describe.each([
      ['signup', 'confirmUrl'],
      ['recovery', 'resetUrl'],
      ['magiclink', 'signInUrl'],
      ['email_change', 'confirmUrl'],
    ])('%s link', (type, urlVar) => {
      const redirectTarget = (request: SendEmailRequest) => {
        const verify = new URL(
          (request.vars as Record<string, string>)[urlVar],
        );
        expect(verify.searchParams.has('lang')).toBe(false);
        return new URL(verify.searchParams.get('redirect_to') as string);
      };

      it.each(['en', 'zh-CN'])(
        'sends a %s user to the portal with that lang, keeping its query',
        async (pref) => {
          const { service, sent } = setup({
            row: { id: 'instr-1', preferred_language: pref as 'en' },
          });
          await service.handle(
            payload(
              {
                email_action_type: type,
                redirect_to: `${REDIRECT}?next=%2Fonboarding`,
                token_hash_new: '',
              },
              { new_email: 'lin.new@example.com' },
            ),
          );
          const target = redirectTarget(sent()[0]);
          expect(`${target.origin}${target.pathname}`).toBe(REDIRECT);
          expect(target.searchParams.get('next')).toBe('/onboarding');
          expect(target.searchParams.get('lang')).toBe(pref);
        },
      );

      it('leaves the portal target without lang for a bilingual email', async () => {
        const { service, sent } = setup({ row: null });
        await service.handle(
          payload(
            { email_action_type: type, token_hash_new: '' },
            { new_email: 'lin.new@example.com' },
          ),
        );
        expect(sent()[0].language).toBe('bilingual');
        expect(redirectTarget(sent()[0]).href).toBe(REDIRECT);
      });
    });

    it('carries lang on both secure email_change links', async () => {
      const { service, sent } = setup({
        row: { id: 'instr-1', preferred_language: 'zh-CN' },
      });
      await service.handle(
        payload(
          {
            email_action_type: 'email_change',
            token_hash: 'hash-for-new-address',
            token_hash_new: 'hash-for-current-address',
          },
          { new_email: 'lin.new@example.com' },
        ),
      );
      expect(sent().map((r) => r.vars)).toEqual([
        expect.objectContaining({
          confirmUrl: link(
            'hash-for-current-address',
            'email_change',
            `${REDIRECT}?lang=zh-CN`,
          ),
        }),
        expect.objectContaining({
          confirmUrl: link(
            'hash-for-new-address',
            'email_change',
            `${REDIRECT}?lang=zh-CN`,
          ),
        }),
      ]);
    });

    it('is bilingual when the user has no instructor row', async () => {
      const { service, sent } = setup({ row: null });
      await service.handle(payload({ email_action_type: 'signup' }));
      expect(sent()[0]).toMatchObject({
        language: 'bilingual',
        instructorId: null,
      });
    });

    it('is bilingual when the lookup fails', async () => {
      const { service, sent } = setup({
        lookup: () => Promise.reject(new Error('db down')),
      });
      await service.handle(payload({ email_action_type: 'signup' }));
      expect(sent()[0]).toMatchObject({ language: 'bilingual' });
    });
  });

  it.each(['failed', 'skipped'] as const)(
    'maps a %s delivery to a 500 with a user-facing message',
    async (outcome) => {
      const send = jest
        .fn()
        .mockRejectedValue(new EmailDeliveryError(outcome, 'resend down'));
      const { service } = setup({ send });
      const result = service.handle(payload({ email_action_type: 'signup' }));
      await expect(result).rejects.toThrow(InternalServerErrorException);
      await expect(result).rejects.toThrow(EMAIL_SEND_FAILED);
    },
  );

  it('rethrows unexpected errors unchanged', async () => {
    const boom = new Error('boom');
    const { service } = setup({ send: jest.fn().mockRejectedValue(boom) });
    await expect(
      service.handle(payload({ email_action_type: 'signup' })),
    ).rejects.toBe(boom);
  });
});
