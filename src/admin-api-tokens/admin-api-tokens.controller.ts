import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Roles, RolesGuard } from '../admin/roles.guard';
import { toActor } from '../audit/admin-actor';
import { CurrentUser } from '../auth/current-user.decorator';
import type { SupabaseJwtPayload } from '../auth/jwt-payload.interface';
import { SessionOnly } from '../auth/session-only.decorator';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import {
  AdminApiTokensService,
  type TokenOwner,
} from './admin-api-tokens.service';
import type {
  AdminApiTokenSummary,
  IssuedAdminApiToken,
} from './admin-api-tokens.types';
import {
  CreateAdminApiTokenDto,
  RotateAdminApiTokenDto,
} from './dto/admin-api-token.dto';

function ownerOf(user: SupabaseJwtPayload, userAgent?: string): TokenOwner {
  return { userId: user.sub, actor: toActor(user, userAgent) };
}

@Controller('admin/api-tokens')
@UseGuards(SupabaseAuthGuard, RolesGuard)
@Roles('admin')
@SessionOnly()
export class AdminApiTokensController {
  constructor(private readonly tokens: AdminApiTokensService) {}

  @Post()
  create(
    @Body() dto: CreateAdminApiTokenDto,
    @CurrentUser() user: SupabaseJwtPayload,
    @Headers('user-agent') userAgent?: string,
  ): Promise<IssuedAdminApiToken> {
    return this.tokens.create(
      ownerOf(user, userAgent),
      dto.name,
      dto.expiresAt,
    );
  }

  @Get()
  list(
    @CurrentUser() user: SupabaseJwtPayload,
  ): Promise<AdminApiTokenSummary[]> {
    return this.tokens.list(user.sub);
  }

  @Post(':id/rotate')
  rotate(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: RotateAdminApiTokenDto,
    @CurrentUser() user: SupabaseJwtPayload,
    @Headers('user-agent') userAgent?: string,
  ): Promise<IssuedAdminApiToken> {
    return this.tokens.rotate(
      ownerOf(user, userAgent),
      id,
      dto.graceMinutes,
      dto.expiresAt,
    );
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  revoke(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @CurrentUser() user: SupabaseJwtPayload,
    @Headers('user-agent') userAgent?: string,
  ): Promise<void> {
    return this.tokens.revoke(ownerOf(user, userAgent), id);
  }
}
