import type { SupabaseJwtPayload } from '../auth/jwt-payload.interface';

/** First/last name + optional nickname captured at sign-up. */
export interface SignupNames {
  firstName?: string;
  lastName?: string;
  nickname?: string | null;
}

/**
 * Pull the names the portal's sign-up form collects out of the verified JWT's
 * `user_metadata` claim (ssms-portal's SignUpPage passes them as Supabase
 * `options.data` at `auth.signUp()`, which Supabase mirrors onto every
 * access token it issues for that user).
 */
export function signupNamesFromJwt(user: SupabaseJwtPayload): SignupNames {
  const meta = user.user_metadata ?? {};
  return {
    firstName: typeof meta.first_name === 'string' ? meta.first_name : undefined,
    lastName: typeof meta.last_name === 'string' ? meta.last_name : undefined,
    nickname: typeof meta.nickname === 'string' ? meta.nickname : null,
  };
}
