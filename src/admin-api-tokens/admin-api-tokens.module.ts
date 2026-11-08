import { Global, Module } from '@nestjs/common';
import { ApiTokenAuthenticator } from '../auth/api-token-authenticator';
import { ApiKeyRateLimiter } from '../public-api/api-key-rate-limiter';
import { AdminApiTokenAuthenticator } from './admin-api-token.authenticator';
import { AdminApiTokenOwners } from './admin-api-token-owners';
import { AdminApiTokensController } from './admin-api-tokens.controller';
import {
  AdminApiTokensRepository,
  SupabaseAdminApiTokensRepository,
} from './admin-api-tokens.repository';
import { AdminApiTokensService } from './admin-api-tokens.service';
import {
  ADMIN_API_TOKEN_CLOCK,
  ADMIN_API_TOKEN_RATE_LIMITER,
} from './admin-api-tokens.types';

@Global()
@Module({
  controllers: [AdminApiTokensController],
  providers: [
    AdminApiTokensService,
    AdminApiTokenOwners,
    {
      provide: AdminApiTokensRepository,
      useClass: SupabaseAdminApiTokensRepository,
    },
    { provide: ADMIN_API_TOKEN_CLOCK, useValue: { now: () => Date.now() } },
    { provide: ADMIN_API_TOKEN_RATE_LIMITER, useClass: ApiKeyRateLimiter },
    { provide: ApiTokenAuthenticator, useClass: AdminApiTokenAuthenticator },
  ],
  exports: [ApiTokenAuthenticator],
})
export class AdminApiTokensModule {}
