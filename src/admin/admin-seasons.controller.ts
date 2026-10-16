import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { toActor } from '../audit/admin-actor';
import { CurrentUser } from '../auth/current-user.decorator';
import type { SupabaseJwtPayload } from '../auth/jwt-payload.interface';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { CreateSeasonDto, UpdateSeasonDto } from '../seasons/dto/season.dto';
import { type AdminSeason, SeasonsService } from '../seasons/seasons.service';
import { Roles, RolesGuard } from './roles.guard';

@Controller('admin/reference/seasons')
@UseGuards(SupabaseAuthGuard, RolesGuard)
@Roles('admin')
export class AdminSeasonsController {
  constructor(private readonly seasons: SeasonsService) {}

  @Get()
  list(): Promise<AdminSeason[]> {
    return this.seasons.adminList();
  }

  @Post()
  create(
    @Body() dto: CreateSeasonDto,
    @CurrentUser() user: SupabaseJwtPayload,
    @Headers('user-agent') userAgent?: string,
  ): Promise<AdminSeason> {
    return this.seasons.create(dto, toActor(user, userAgent));
  }

  @Patch(':key')
  update(
    @Param('key') key: string,
    @Body() dto: UpdateSeasonDto,
    @CurrentUser() user: SupabaseJwtPayload,
    @Headers('user-agent') userAgent?: string,
  ): Promise<AdminSeason> {
    return this.seasons.update(key, dto, toActor(user, userAgent));
  }

  @Delete(':key')
  remove(
    @Param('key') key: string,
    @CurrentUser() user: SupabaseJwtPayload,
    @Headers('user-agent') userAgent?: string,
  ): Promise<AdminSeason> {
    return this.seasons.remove(key, toActor(user, userAgent));
  }
}
