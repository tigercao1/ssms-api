import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import { EmailVerifiedGuard } from '../auth/email-verified.guard';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import type { SupabaseJwtPayload } from '../auth/jwt-payload.interface';
import { UpdateInstructorProfileDto } from './dto/update-instructor-profile.dto';
import { InstructorProfile } from './instructors.types';
import { InstructorsService } from './instructors.service';

/**
 * Self-service instructor profile endpoints (`/me/instructor`).
 *
 * Both routes require a valid Supabase JWT (SupabaseAuthGuard) AND a verified
 * email (EmailVerifiedGuard) — see INSTRUCTOR_LOGIN.md. Ownership is implicit:
 * everything is scoped to the JWT subject (`sub`), so a token can only ever
 * touch its own row.
 */
@Controller('me/instructor')
@UseGuards(SupabaseAuthGuard, EmailVerifiedGuard)
export class InstructorsController {
  constructor(private readonly instructors: InstructorsService) {}

  /**
   * T3.1 — Fetch the caller's profile. First verified call auto-creates a
   * `pending` row; subsequent calls return the same row (idempotent).
   */
  @Get()
  getMe(@CurrentUser() user: SupabaseJwtPayload): Promise<InstructorProfile> {
    return this.instructors.getOrCreateForUser(user.sub, user.email ?? '');
  }

  /**
   * T3.2 — Update the caller's profile. Allowed in every approval_status;
   * email is not part of the DTO so it cannot be changed here.
   */
  @Patch()
  updateMe(
    @CurrentUser() user: SupabaseJwtPayload,
    @Body() dto: UpdateInstructorProfileDto,
  ): Promise<InstructorProfile> {
    return this.instructors.updateOwnProfile(user.sub, dto);
  }
}
