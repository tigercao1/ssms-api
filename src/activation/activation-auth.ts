import {
  Inject,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../database/supabase-client.token';

/** The Supabase Auth admin calls the activation flow needs. */
export abstract class ActivationAuth {
  /** Current email of an auth user, or null when the user no longer exists. */
  abstract findEmail(authUserId: string): Promise<string | null>;
  /**
   * A one-time magic-link `hashed_token` for an existing user. Generating a
   * link sends no email; the portal exchanges it with `verifyOtp`.
   */
  abstract magicLinkTokenHash(email: string): Promise<string>;
}

/** {@link ActivationAuth} over the service-role Supabase client. */
@Injectable()
export class SupabaseActivationAuth extends ActivationAuth {
  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
  ) {
    super();
  }

  async findEmail(authUserId: string): Promise<string | null> {
    const { data, error } =
      await this.supabase.auth.admin.getUserById(authUserId);
    if (error) {
      if (error.status === 404) {
        return null;
      }
      throw new InternalServerErrorException(
        `Failed to load auth user: ${error.message}`,
      );
    }
    return data.user?.email ?? null;
  }

  async magicLinkTokenHash(email: string): Promise<string> {
    const { data, error } = await this.supabase.auth.admin.generateLink({
      type: 'magiclink',
      email,
    });
    const hashed = data?.properties?.hashed_token;
    if (error || !hashed) {
      throw new InternalServerErrorException(
        `Failed to generate sign-in link: ${error?.message ?? 'no token returned'}`,
      );
    }
    return hashed;
  }
}
