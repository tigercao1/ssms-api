import { Module } from '@nestjs/common';
import { InstructorsModule } from '../instructors/instructors.module';
import { MailerModule } from '../mailer/mailer.module';
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
 * MailerModule is imported for T8.1: on approve / reject / deactivate the
 * service fires a fire-and-forget notification via MailerService. Failures are
 * audited by the mailer as `notification.failure` and MUST NOT roll back the
 * admin action.
 */
@Module({
  imports: [InstructorsModule, MailerModule],
  controllers: [AdminController],
  providers: [
    AdminService,
    { provide: AdminRepository, useClass: SupabaseAdminRepository },
  ],
})
export class AdminModule {}
