import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';
import { SupabaseJwtPayload } from './jwt-payload.interface';

/**
 * Enforces verified email (T1.2). Use AFTER SupabaseAuthGuard so request.user
 * is populated. Unverified email → 403.
 *
 * Checks the `email_confirmed_at` claim (per TESTING_STRATEGY.md); also accepts
 * `user_metadata.email_verified === true` as a fallback across Supabase
 * token variants.
 */
@Injectable()
export class EmailVerifiedGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const user = req.user as SupabaseJwtPayload | undefined;

    const verified =
      Boolean(user?.email_confirmed_at) ||
      user?.user_metadata?.email_verified === true;

    if (!verified) {
      throw new ForbiddenException('Email not verified');
    }
    return true;
  }
}
