import { BadRequestException } from '@nestjs/common';

/**
 * The subset of the Supabase Send Email hook payload the API uses. See
 * https://supabase.com/docs/guides/auth/auth-hooks/send-email-hook.
 */
export interface SendEmailHookPayload {
  user: SendEmailHookUser;
  email_data: SendEmailHookEmailData;
}

export interface SendEmailHookUser {
  id: string;
  email: string;
  new_email: string;
}

export interface SendEmailHookEmailData {
  email_action_type: string;
  token: string;
  token_hash: string;
  redirect_to: string;
  site_url: string;
  token_new: string;
  token_hash_new: string;
  old_email: string;
  provider: string;
  factor_type: string;
}

const EMAIL_DATA_STRING_FIELDS = [
  'token',
  'token_hash',
  'redirect_to',
  'site_url',
  'token_new',
  'token_hash_new',
  'old_email',
  'provider',
  'factor_type',
] as const;

/**
 * Validates a verified hook body and normalises optional string fields to
 * `''`. Throws {@link BadRequestException} when the shape is wrong.
 */
export function parseSendEmailHookPayload(body: unknown): SendEmailHookPayload {
  if (!isRecord(body) || !isRecord(body.user) || !isRecord(body.email_data)) {
    throw new BadRequestException('Payload must contain user and email_data');
  }
  const { user, email_data: data } = body;
  const id = requiredString(user.id, 'user.id');
  const actionType = requiredString(
    data.email_action_type,
    'email_data.email_action_type',
  );
  const emailData = { email_action_type: actionType } as SendEmailHookEmailData;
  for (const field of EMAIL_DATA_STRING_FIELDS) {
    emailData[field] = optionalString(data[field], `email_data.${field}`);
  }
  return {
    user: {
      id,
      email: optionalString(user.email, 'user.email'),
      new_email: optionalString(user.new_email, 'user.new_email'),
    },
    email_data: emailData,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new BadRequestException(`${field} is required`);
  }
  return value;
}

function optionalString(value: unknown, field: string): string {
  if (value === undefined || value === null) {
    return '';
  }
  if (typeof value !== 'string') {
    throw new BadRequestException(`${field} must be a string`);
  }
  return value.trim();
}
