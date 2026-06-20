import { Module } from '@nestjs/common';
import { ApiKeyRateLimiter } from './api-key-rate-limiter';
import { ApiKeyGuard } from './api-key.guard';
import {
  ApiKeysRepository,
  SupabaseApiKeysRepository,
} from './api-keys.repository';
import { ApiKeysService } from './api-keys.service';
import { PublicInstructorsController } from './public-instructors.controller';
import {
  PublicInstructorsRepository,
  SupabasePublicInstructorsRepository,
} from './public-instructors.repository';
import { PublicInstructorsService } from './public-instructors.service';

/**
 * PublicApiModule — external read-only instructor API (`/public/v1/*`) plus
 * API-key issuance/auth (PUBLIC_API_PLAN.md).
 *
 * Depends on the global DatabaseModule (SUPABASE_CLIENT). Repositories are bound
 * behind abstract tokens so tests can swap in-memory fakes. `ApiKeysService` is
 * exported so an admin/bootstrap path can issue keys without re-wiring the DB.
 *
 * NOTE: this module must be registered in `AppModule.imports` — see the FLAG to
 * the Wave 0/1 owner (the agent may not edit app.module.ts).
 */
@Module({
  controllers: [PublicInstructorsController],
  providers: [
    ApiKeyGuard,
    ApiKeyRateLimiter,
    ApiKeysService,
    PublicInstructorsService,
    { provide: ApiKeysRepository, useClass: SupabaseApiKeysRepository },
    {
      provide: PublicInstructorsRepository,
      useClass: SupabasePublicInstructorsRepository,
    },
  ],
  exports: [ApiKeysService],
})
export class PublicApiModule {}
