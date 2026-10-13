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
  Put,
  Query,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { Roles, RolesGuard } from '../admin/roles.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { SupabaseJwtPayload } from '../auth/jwt-payload.interface';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { toActor } from '../audit/admin-actor';
import { GoogleErrorFilter } from '../google/google-error.filter';
import { type Availability, AvailabilityService } from './availability.service';
import {
  type BookingSettings,
  BookingSettingsService,
} from './booking-settings.service';
import {
  BookingService,
  type LastClass,
  type SyncIssues,
} from './booking.service';
import type { BookedClass } from './calendar-sync.service';
import {
  AvailabilityQueryDto,
  BookingSettingsDto,
  CreateBookingDto,
  SetClassStatusDto,
  UpdateBookingDto,
} from './dto/booking.dto';

@Controller('admin/booking')
@UseGuards(SupabaseAuthGuard, RolesGuard)
@UseFilters(GoogleErrorFilter)
@Roles('admin')
export class BookingController {
  constructor(
    private readonly booking: BookingService,
    private readonly availabilityService: AvailabilityService,
    private readonly settings: BookingSettingsService,
  ) {}

  @Get('settings')
  getSettings(): Promise<BookingSettings> {
    return this.settings.get();
  }

  @Put('settings')
  updateSettings(
    @Body() dto: BookingSettingsDto,
    @CurrentUser() user: SupabaseJwtPayload,
    @Headers('user-agent') userAgent?: string,
  ): Promise<BookingSettings> {
    return this.settings.update(dto, toActor(user, userAgent));
  }

  @Get('availability')
  availability(@Query() query: AvailabilityQueryDto): Promise<Availability> {
    return this.availabilityService.availability({
      date: query.date,
      lessonTypeId: query.lessonTypeId,
      instructorIds: query.instructorIds,
    });
  }

  @Post('classes')
  create(
    @Body() dto: CreateBookingDto,
    @CurrentUser() user: SupabaseJwtPayload,
    @Headers('user-agent') userAgent?: string,
  ): Promise<BookedClass[]> {
    return this.booking.create(dto, toActor(user, userAgent));
  }

  @Patch('classes/:id')
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateBookingDto,
    @CurrentUser() user: SupabaseJwtPayload,
    @Headers('user-agent') userAgent?: string,
  ): Promise<BookedClass> {
    return this.booking.update(id, dto, toActor(user, userAgent));
  }

  @Post('classes/:id/cancel')
  @HttpCode(HttpStatus.OK)
  cancel(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: SupabaseJwtPayload,
    @Headers('user-agent') userAgent?: string,
  ): Promise<BookedClass> {
    return this.booking.cancel(id, toActor(user, userAgent));
  }

  @Post('classes/:id/status')
  @HttpCode(HttpStatus.OK)
  setStatus(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: SetClassStatusDto,
    @CurrentUser() user: SupabaseJwtPayload,
    @Headers('user-agent') userAgent?: string,
  ): Promise<BookedClass> {
    return this.booking.setStatus(id, dto.status, toActor(user, userAgent));
  }

  @Post('classes/:id/sync')
  @HttpCode(HttpStatus.OK)
  retrySync(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: SupabaseJwtPayload,
    @Headers('user-agent') userAgent?: string,
  ): Promise<BookedClass> {
    return this.booking.retrySync(id, toActor(user, userAgent));
  }

  @Get('sync-issues')
  syncIssues(): Promise<SyncIssues> {
    return this.booking.syncIssues();
  }

  @Get('customers/:id/last')
  last(
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<{ last: LastClass | null }> {
    return this.booking.lastFor(id);
  }
}
