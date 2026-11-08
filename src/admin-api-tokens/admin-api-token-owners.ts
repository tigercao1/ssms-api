import {
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { SupabaseClient, User } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../database/supabase-client.token';
import {
  ADMIN_API_TOKEN_CLOCK,
  type AdminApiTokenClock,
} from './admin-api-tokens.types';

export const ADMIN_API_TOKEN_OWNER_TTL_MS = 30_000;

export interface AdminApiTokenOwner {
  id: string;
  email: string | null;
  emailConfirmedAt: string | null;
}

function isActiveAdmin(user: User, now: number): boolean {
  if (user.app_metadata?.role !== 'admin') {
    return false;
  }
  const bannedUntil = user.banned_until ? Date.parse(user.banned_until) : NaN;
  return !(bannedUntil > now) && !user.deleted_at;
}

@Injectable()
export class AdminApiTokenOwners {
  private readonly cached = new Map<
    string,
    { owner: AdminApiTokenOwner; until: number }
  >();

  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
    @Inject(ADMIN_API_TOKEN_CLOCK) private readonly clock: AdminApiTokenClock,
  ) {}

  async activeAdmin(userId: string): Promise<AdminApiTokenOwner | null> {
    const now = this.clock.now();
    const hit = this.cached.get(userId);
    if (hit !== undefined && hit.until > now) {
      return hit.owner;
    }
    this.cached.delete(userId);

    let result: Awaited<
      ReturnType<SupabaseClient['auth']['admin']['getUserById']>
    >;
    try {
      result = await this.supabase.auth.admin.getUserById(userId);
    } catch {
      throw new ServiceUnavailableException('Token owner check unavailable');
    }
    if (result.error) {
      if (result.error.status === 404) {
        return null;
      }
      throw new ServiceUnavailableException('Token owner check unavailable');
    }
    const user = result.data.user;
    if (!user || !isActiveAdmin(user, now)) {
      return null;
    }
    const owner: AdminApiTokenOwner = {
      id: user.id,
      email: user.email ?? null,
      emailConfirmedAt: user.email_confirmed_at ?? null,
    };
    this.cached.set(userId, {
      owner,
      until: now + ADMIN_API_TOKEN_OWNER_TTL_MS,
    });
    return owner;
  }
}
