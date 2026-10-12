import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Patch,
  UseGuards,
} from '@nestjs/common';
import { Roles, RolesGuard } from '../admin/roles.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { SupabaseJwtPayload } from '../auth/jwt-payload.interface';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { toActor } from './admin-actor';
import { UpdateGoogleCalendarDto } from './dto/update-google-calendar.dto';
import {
  type InstructorGoogleCalendar,
  InstructorCalendarsService,
} from './instructor-calendars.service';

@Controller('admin/instructors')
@UseGuards(SupabaseAuthGuard, RolesGuard)
@Roles('admin')
export class InstructorCalendarsController {
  constructor(private readonly calendars: InstructorCalendarsService) {}

  @Get(':id/google-calendar')
  get(
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<InstructorGoogleCalendar> {
    return this.calendars.get(id);
  }

  @Patch(':id/google-calendar')
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateGoogleCalendarDto,
    @CurrentUser() user: SupabaseJwtPayload,
    @Headers('user-agent') userAgent?: string,
  ): Promise<InstructorGoogleCalendar> {
    return this.calendars.set(
      id,
      dto.googleCalendarId,
      toActor(user, userAgent),
    );
  }
}
