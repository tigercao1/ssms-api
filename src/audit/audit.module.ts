import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit.service';

/**
 * T6.8 — AuditModule. Global so any feature module can inject {@link AuditService}
 * without re-importing (mirrors DatabaseModule). It depends only on the global
 * SUPABASE_CLIENT, so it carries no feature-module coupling and stays safe to
 * import once at the app root.
 */
@Global()
@Module({
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
