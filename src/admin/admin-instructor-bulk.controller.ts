import { Body, Controller, Headers, Patch, UseGuards } from '@nestjs/common';
import { toActor } from '../audit/admin-actor';
import { CurrentUser } from '../auth/current-user.decorator';
import type { SupabaseJwtPayload } from '../auth/jwt-payload.interface';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import {
  AdminInstructorBulkService,
  type BulkUpdateInstructorsResult,
} from './admin-instructor-bulk.service';
import { BulkUpdateInstructorsDto } from './dto/bulk-update-instructors.dto';
import { Roles, RolesGuard } from './roles.guard';

@Controller('admin/instructors')
@UseGuards(SupabaseAuthGuard, RolesGuard)
@Roles('admin')
export class AdminInstructorBulkController {
  constructor(private readonly bulk: AdminInstructorBulkService) {}

  @Patch()
  updateMany(
    @Body() dto: BulkUpdateInstructorsDto,
    @CurrentUser() user: SupabaseJwtPayload,
    @Headers('user-agent') userAgent?: string,
  ): Promise<BulkUpdateInstructorsResult> {
    return this.bulk.update(dto, toActor(user, userAgent));
  }
}
