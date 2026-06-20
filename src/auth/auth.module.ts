import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { SupabaseJwtStrategy } from './supabase-jwt.strategy';
import { EmailVerifiedGuard } from './email-verified.guard';

/**
 * AuthModule — JWT verification only. NestJS does NOT handle passwords;
 * sign-up / sign-in / password-reset happen client-side via Supabase Auth
 * (AUTH_V1_DECISIONS.md). The backend's job is to verify the resulting JWT
 * and expose guards + the @CurrentUser decorator.
 */
@Module({
  imports: [PassportModule],
  providers: [SupabaseJwtStrategy, EmailVerifiedGuard],
  exports: [EmailVerifiedGuard],
})
export class AuthModule {}
