import { parseAllowedOrigins } from '../config/cors';
import { PRIVATE_STORAGE_ENV } from '../documents/private-storage.client';

const REQUIRED_ENV = ['SUPABASE_URL', 'SUPABASE_SECRET_KEY'] as const;
const REQUIRED_IN_PRODUCTION = [
  'CORS_ALLOWED_ORIGINS',
  ...PRIVATE_STORAGE_ENV,
  'RESEND_API_KEY',
  'MAIL_FROM',
] as const;

const isBlank = (value: unknown) =>
  typeof value !== 'string' || value.trim() === '';

export function validateSignEnv(config: Record<string, unknown>) {
  const required: readonly string[] =
    config.NODE_ENV === 'production'
      ? [...REQUIRED_ENV, ...REQUIRED_IN_PRODUCTION]
      : REQUIRED_ENV;
  const missing = required.filter((key) => isBlank(config[key]));
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}. ` +
        'See .env.example.',
    );
  }
  const origins = parseAllowedOrigins(
    config.CORS_ALLOWED_ORIGINS as string | undefined,
  );
  const invalid = origins.filter(
    (origin) => !/^https?:\/\/[^/*]+$/.test(origin),
  );
  if (invalid.length > 0) {
    throw new Error(
      `CORS_ALLOWED_ORIGINS must list exact origins, got: ${invalid.join(', ')}`,
    );
  }
  return config;
}
