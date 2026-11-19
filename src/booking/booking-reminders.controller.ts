import { Body, Controller, Get, Headers, Put, UseGuards } from '@nestjs/common';
import { Roles, RolesGuard } from '../admin/roles.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { SupabaseJwtPayload } from '../auth/jwt-payload.interface';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { toActor } from '../audit/admin-actor';
import {
  type BookingReminderSettings,
  BookingReminderSettingsService,
} from './booking-reminder-settings.service';
import { BookingReminderSettingsDto } from './dto/booking.dto';

@Controller('admin/booking/reminder-settings')
@UseGuards(SupabaseAuthGuard, RolesGuard)
@Roles('admin')
export class BookingRemindersController {
  constructor(private readonly settings: BookingReminderSettingsService) {}

  @Get()
  get(): Promise<BookingReminderSettings> {
    return this.settings.get();
  }

  @Put()
  update(
    @Body() dto: BookingReminderSettingsDto,
    @CurrentUser() user: SupabaseJwtPayload,
    @Headers('user-agent') userAgent?: string,
  ): Promise<BookingReminderSettings> {
    return this.settings.update(dto, toActor(user, userAgent));
  }
}
