import { Module } from '@nestjs/common';
import { InstructorsModule } from '../instructors/instructors.module';
import { AdminController } from './admin.controller';
import { AdminRepository, SupabaseAdminRepository } from './admin.repository';
import { AdminService } from './admin.service';

/**
 * AdminModule — the `/admin/*` management surface (ADMIN_ROLE_PLAN.md).
 *
 * Gated by RolesGuard (`app_metadata.role === 'admin'`, T6.1). Imports
 * InstructorsModule to reuse its exported `InstructorsService.updateProfileById`
 * for full profile edits (T6.6). Reference-row inserts (T6.7) and instructor
 * state transitions go through the global DatabaseModule (SUPABASE_CLIENT) via
 * the AdminRepository, which is bound behind an abstract token so tests can
 * swap an in-memory fake.
 *
 * Audit (T6.8) and notification (T8.1) wiring are added later by the
 * integration agent; this module deliberately carries no dependency on them.
 */
@Module({
  imports: [InstructorsModule],
  controllers: [AdminController],
  providers: [
    AdminService,
    { provide: AdminRepository, useClass: SupabaseAdminRepository },
  ],
})
export class AdminModule {}
