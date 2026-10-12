import {
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Redirect,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { Roles, RolesGuard } from '../admin/roles.guard';
import type { AuditActor } from '../audit/audit.types';
import { CurrentUser } from '../auth/current-user.decorator';
import type { SupabaseJwtPayload } from '../auth/jwt-payload.interface';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { FreeBusyQueryDto } from './dto/freebusy-query.dto';
import type {
  AdminGoogleCalendar,
  FreeBusyResult,
  GoogleConnectionStatus,
} from './google.types';
import { GoogleConnectionService } from './google-connection.service';
import { GoogleErrorFilter } from './google-error.filter';

function toActor(user: SupabaseJwtPayload, userAgent?: string): AuditActor {
  return { userId: user.sub, role: 'admin', userAgent: userAgent ?? null };
}

@Controller('admin/google')
@UseGuards(SupabaseAuthGuard, RolesGuard)
@UseFilters(GoogleErrorFilter)
@Roles('admin')
export class GoogleAdminController {
  constructor(private readonly google: GoogleConnectionService) {}

  @Get('connect')
  connect(@CurrentUser() user: SupabaseJwtPayload): { url: string } {
    return this.google.connectUrl(user.sub);
  }

  @Get('status')
  status(): Promise<GoogleConnectionStatus> {
    return this.google.status();
  }

  @Post('disconnect')
  @HttpCode(HttpStatus.OK)
  disconnect(
    @CurrentUser() user: SupabaseJwtPayload,
    @Headers('user-agent') userAgent?: string,
  ): Promise<GoogleConnectionStatus> {
    return this.google.disconnect(toActor(user, userAgent));
  }

  @Get('calendars')
  calendars(): Promise<AdminGoogleCalendar[]> {
    return this.google.calendars();
  }

  @Get('freebusy')
  freeBusy(@Query() query: FreeBusyQueryDto): Promise<FreeBusyResult> {
    return this.google.freeBusy(query.calendarIds, query.from, query.to);
  }
}

@Controller('admin/google/oauth')
export class GoogleOAuthCallbackController {
  constructor(private readonly google: GoogleConnectionService) {}

  @Get('callback')
  @Redirect()
  async callback(
    @Query('code') code?: string,
    @Query('state') state?: string,
    @Query('error') error?: string,
  ): Promise<{ url: string; statusCode: number }> {
    const url = await this.google.handleCallback({
      code: typeof code === 'string' ? code : undefined,
      state: typeof state === 'string' ? state : undefined,
      error: typeof error === 'string' ? error : undefined,
    });
    return { url, statusCode: HttpStatus.FOUND };
  }
}
