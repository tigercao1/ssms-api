import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { Roles, RolesGuard } from '../admin/roles.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { SupabaseJwtPayload } from '../auth/jwt-payload.interface';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { GoogleErrorFilter } from '../google/google-error.filter';
import { toActor } from '../audit/admin-actor';
import { UpdateGoogleCalendarDto } from './dto/update-google-calendar.dto';
import {
  type InstructorCalendarsOverview,
  type InstructorGoogleCalendar,
  InstructorCalendarsService,
  type SuggestCalendarsResult,
} from './instructor-calendars.service';

@Controller('admin')
@UseGuards(SupabaseAuthGuard, RolesGuard)
@UseFilters(GoogleErrorFilter)
@Roles('admin')
export class InstructorCalendarsController {
  constructor(private readonly calendars: InstructorCalendarsService) {}

  @Get('instructor-calendars')
  overview(): Promise<InstructorCalendarsOverview> {
    return this.calendars.overview();
  }

  @Post('instructor-calendars/suggest')
  @HttpCode(HttpStatus.OK)
  suggest(
    @CurrentUser() user: SupabaseJwtPayload,
    @Headers('user-agent') userAgent?: string,
  ): Promise<SuggestCalendarsResult> {
    return this.calendars.suggest(toActor(user, userAgent));
  }

  @Patch('instructor-calendars/:instructorId')
  updateLink(
    @Param('instructorId', new ParseUUIDPipe()) instructorId: string,
    @Body() dto: UpdateGoogleCalendarDto,
    @CurrentUser() user: SupabaseJwtPayload,
    @Headers('user-agent') userAgent?: string,
  ): Promise<InstructorGoogleCalendar> {
    return this.update(instructorId, dto, user, userAgent);
  }

  @Get('instructors/:id/google-calendar')
  get(
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<InstructorGoogleCalendar> {
    return this.calendars.get(id);
  }

  @Patch('instructors/:id/google-calendar')
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateGoogleCalendarDto,
    @CurrentUser() user: SupabaseJwtPayload,
    @Headers('user-agent') userAgent?: string,
  ): Promise<InstructorGoogleCalendar> {
    return this.calendars.set(
      id,
      {
        googleCalendarId: dto.googleCalendarId,
        matchStatus: dto.matchStatus,
      },
      toActor(user, userAgent),
    );
  }
}
