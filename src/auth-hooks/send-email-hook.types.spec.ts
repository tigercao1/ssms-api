import { BadRequestException } from '@nestjs/common';
import { parseSendEmailHookPayload } from './send-email-hook.types';

describe('parseSendEmailHookPayload', () => {
  it('keeps the fields the hook uses and defaults missing strings to empty', () => {
    expect(
      parseSendEmailHookPayload({
        user: { id: 'u1', email: ' lin@example.com ', phone: '' },
        email_data: { email_action_type: 'signup', token_hash: 'h' },
      }),
    ).toEqual({
      user: { id: 'u1', email: 'lin@example.com', new_email: '' },
      email_data: {
        email_action_type: 'signup',
        token: '',
        token_hash: 'h',
        redirect_to: '',
        site_url: '',
        token_new: '',
        token_hash_new: '',
        old_email: '',
        provider: '',
        factor_type: '',
      },
    });
  });

  it.each([
    ['a non-object body', 'nope'],
    ['an array body', []],
    ['a missing user', { email_data: { email_action_type: 'signup' } }],
    ['a missing email_data', { user: { id: 'u1' } }],
    ['a blank user.id', { user: { id: ' ' }, email_data: {} }],
    ['a missing action type', { user: { id: 'u1' }, email_data: {} }],
    [
      'a non-string token',
      {
        user: { id: 'u1' },
        email_data: { email_action_type: 'signup', token: 123 },
      },
    ],
  ])('rejects %s', (_label, body) => {
    expect(() => parseSendEmailHookPayload(body)).toThrow(BadRequestException);
  });
});
