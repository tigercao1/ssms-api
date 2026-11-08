import {
  Body,
  Controller,
  Headers,
  Param,
  ParseUUIDPipe,
  Patch,
  UseGuards,
} from '@nestjs/common';
import { toActor } from '../audit/admin-actor';
import { CurrentUser } from '../auth/current-user.decorator';
import type { SupabaseJwtPayload } from '../auth/jwt-payload.interface';
import { SessionOnly } from '../auth/session-only.decorator';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { AdminInstructorEmailService } from './admin-instructor-email.service';
import type { AdminInstructorRecord } from './admin.types';
import { UpdateInstructorEmailDto } from './dto/update-instructor-email.dto';
import { Roles, RolesGuard } from './roles.guard';

@Controller('admin/instructors/:id/email')
@UseGuards(SupabaseAuthGuard, RolesGuard)
@Roles('admin')
export class AdminInstructorEmailController {
  constructor(private readonly emails: AdminInstructorEmailService) {}

  @Patch()
  @SessionOnly()
  changeEmail(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdateInstructorEmailDto,
    @CurrentUser() user: SupabaseJwtPayload,
    @Headers('user-agent') userAgent?: string,
  ): Promise<AdminInstructorRecord> {
    return this.emails.changeEmail(id, dto, toActor(user, userAgent));
  }
}
