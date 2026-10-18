import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  UseGuards,
} from '@nestjs/common';
import { Roles, RolesGuard } from '../admin/roles.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { EmailVerifiedGuard } from '../auth/email-verified.guard';
import type { SupabaseJwtPayload } from '../auth/jwt-payload.interface';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import type { GoLiveStatus } from './go-live';
import { GoLiveService } from './go-live.service';

/** `/me/go-live`: what the calling instructor still needs before going live. */
@Controller('me/go-live')
@UseGuards(SupabaseAuthGuard, EmailVerifiedGuard)
export class MeGoLiveController {
  constructor(private readonly goLive: GoLiveService) {}

  @Get()
  status(@CurrentUser() user: SupabaseJwtPayload): Promise<GoLiveStatus> {
    return this.goLive.mine(user.sub);
  }
}

/** `/admin/instructors/:id/go-live`: the same check for any instructor. */
@Controller('admin/instructors')
@UseGuards(SupabaseAuthGuard, RolesGuard)
@Roles('admin')
export class AdminGoLiveController {
  constructor(private readonly goLive: GoLiveService) {}

  @Get(':id/go-live')
  status(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ): Promise<GoLiveStatus> {
    return this.goLive.status(id);
  }
}
