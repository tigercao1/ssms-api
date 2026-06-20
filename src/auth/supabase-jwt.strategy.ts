import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { passportJwtSecret } from 'jwks-rsa';
import { SupabaseJwtPayload } from './jwt-payload.interface';

/**
 * Verifies Supabase access tokens (T1.3).
 *
 * Supabase signs tokens with an asymmetric JWT signing key (ECC P-256 / ES256).
 * We verify against the project's PUBLIC keys, fetched + cached from the JWKS
 * endpoint by `jwks-rsa` (handles `kid`-based rotation, caching, rate-limiting).
 * No signing secret lives in our env.
 *
 * NOTE: pinned to jwks-rsa@^3 (CommonJS jose@4). jwks-rsa@4 pulls ESM-only
 * jose@6 and require()s it, which breaks on any Node that doesn't allow
 * require(ESM). Keep this on ^3.
 *
 * JWKS URL defaults to `${SUPABASE_URL}/auth/v1/.well-known/jwks.json`
 * (override with SUPABASE_JWKS_URL).
 *
 * Tests mint ES256 tokens with an ephemeral test key pair and point the
 * provider at a local/stubbed JWKS — see TESTING_STRATEGY.md. Tokens must carry
 * aud="authenticated".
 */
@Injectable()
export class SupabaseJwtStrategy extends PassportStrategy(
  Strategy,
  'supabase-jwt',
) {
  constructor(config: ConfigService) {
    const supabaseUrl = config
      .getOrThrow<string>('SUPABASE_URL')
      .replace(/\/+$/, '');
    const jwksUri =
      config.get<string>('SUPABASE_JWKS_URL') ??
      `${supabaseUrl}/auth/v1/.well-known/jwks.json`;

    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      audience: 'authenticated',
      algorithms: ['ES256'],
      secretOrKeyProvider: passportJwtSecret({
        jwksUri,
        cache: true,
        rateLimit: true,
        jwksRequestsPerMinute: 10,
      }),
    });
  }

  validate(payload: SupabaseJwtPayload): SupabaseJwtPayload {
    return payload;
  }
}
