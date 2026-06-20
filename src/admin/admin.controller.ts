import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { SupabaseJwtPayload } from '../auth/jwt-payload.interface';
import type { AuditActor } from '../audit/audit.types';
import { UpdateInstructorProfileDto } from '../instructors/dto/update-instructor-profile.dto';
import type { InstructorProfile } from '../instructors/instructors.types';
import { AdminService } from './admin.service';
import {
  AdminInstructorRecord,
  REFERENCE_SLUG_TO_TABLE,
  ReferenceRecord,
  ReferenceSlug,
  UserRoleRecord,
} from './admin.types';
import { CreateReferenceDto } from './dto/create-reference.dto';
import { ListInstructorsQueryDto } from './dto/list-instructors-query.dto';
import { UpdateActivationDto } from './dto/update-activation.dto';
import { UpdateApprovalStatusDto } from './dto/update-approval-status.dto';
import { UpdateRoleDto } from './dto/update-role.dto';
import { Roles, RolesGuard } from './roles.guard';

/** Builds the audit actor from the verified admin JWT + request user-agent. */
function toActor(user: SupabaseJwtPayload, userAgent?: string): AuditActor {
  return { userId: user.sub, role: 'admin', userAgent: userAgent ?? null };
}

/**
 * Admin surface (`/admin/*`). Every route requires a valid Supabase JWT
 * (SupabaseAuthGuard) AND `app_metadata.role === 'admin'` (RolesGuard) — see
 * ADMIN_ROLE_PLAN.md. Non-admins get 403 (T6.1).
 */
@Controller('admin')
@UseGuards(SupabaseAuthGuard, RolesGuard)
@Roles('admin')
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  /** T6.3 — list instructors of every status, optional `?status=`/`?active=`. */
  @Get('instructors')
  listInstructors(
    @Query() query: ListInstructorsQueryDto,
  ): Promise<AdminInstructorRecord[]> {
    return this.admin.listInstructors({
      status: query.status,
      isActive: query.active,
    });
  }

  /** Single instructor core record (admin detail). */
  @Get('instructors/:id')
  getInstructor(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ): Promise<AdminInstructorRecord> {
    return this.admin.getInstructor(id);
  }

  /** T6.4 — approve / reject a pending instructor (valid transitions only). */
  @Patch('instructors/:id/approval')
  setApproval(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdateApprovalStatusDto,
    @CurrentUser() user: SupabaseJwtPayload,
    @Headers('user-agent') userAgent?: string,
  ): Promise<AdminInstructorRecord> {
    return this.admin.setApprovalStatus(
      id,
      dto.approvalStatus,
      dto.reason,
      toActor(user, userAgent),
    );
  }

  /** T6.5 — activate / deactivate (deactivation hides from the public API). */
  @Patch('instructors/:id/activation')
  setActivation(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdateActivationDto,
    @CurrentUser() user: SupabaseJwtPayload,
    @Headers('user-agent') userAgent?: string,
  ): Promise<AdminInstructorRecord> {
    return this.admin.setActive(id, dto.isActive, toActor(user, userAgent));
  }

  /** v1.x — promote / demote a user (sets server-only `app_metadata.role`). */
  @Patch('users/:id/role')
  setUserRole(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdateRoleDto,
    @CurrentUser() user: SupabaseJwtPayload,
    @Headers('user-agent') userAgent?: string,
  ): Promise<UserRoleRecord> {
    return this.admin.setUserRole(id, dto.role, toActor(user, userAgent));
  }

  /** T6.6 — full edit of any instructor's profile (reuses instructor update). */
  @Patch('instructors/:id')
  updateProfile(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdateInstructorProfileDto,
  ): Promise<InstructorProfile> {
    return this.admin.updateProfile(id, dto);
  }

  /** T6.7 — add a reference (lookup) row of the given `:type` slug. */
  @Post('reference/:type')
  addReference(
    @Param('type') type: string,
    @Body() dto: CreateReferenceDto,
  ): Promise<ReferenceRecord> {
    if (!(type in REFERENCE_SLUG_TO_TABLE)) {
      throw new BadRequestException(
        `Unknown reference type '${type}'. Expected one of: ` +
          Object.keys(REFERENCE_SLUG_TO_TABLE).join(', '),
      );
    }
    return this.admin.addReference(type as ReferenceSlug, dto);
  }
}
