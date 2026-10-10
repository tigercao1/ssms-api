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
  UseGuards,
} from '@nestjs/common';
import { Roles, RolesGuard } from '../admin/roles.guard';
import type { AuditActor } from '../audit/audit.types';
import { CurrentUser } from '../auth/current-user.decorator';
import type { SupabaseJwtPayload } from '../auth/jwt-payload.interface';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { RunShopifySyncDto } from './dto/run-shopify-sync.dto';
import { UpdateShopifySyncDto } from './dto/update-shopify-sync.dto';
import {
  type InstructorShopifySyncStatus,
  ShopifySyncAdminService,
  type ShopifySyncRunResult,
  type ShopifySyncStatus,
} from './shopify-sync-admin.service';

function toActor(user: SupabaseJwtPayload, userAgent?: string): AuditActor {
  return { userId: user.sub, role: 'admin', userAgent: userAgent ?? null };
}

@Controller('admin/shopify-sync')
@UseGuards(SupabaseAuthGuard, RolesGuard)
@Roles('admin')
export class ShopifySyncAdminController {
  constructor(private readonly admin: ShopifySyncAdminService) {}

  @Get('status')
  status(): Promise<ShopifySyncStatus> {
    return this.admin.status();
  }

  @Patch()
  setEnabled(
    @Body() dto: UpdateShopifySyncDto,
    @CurrentUser() user: SupabaseJwtPayload,
    @Headers('user-agent') userAgent?: string,
  ): Promise<ShopifySyncStatus> {
    return this.admin.setEnabled(dto.enabled, toActor(user, userAgent));
  }

  @Post('run')
  @HttpCode(HttpStatus.OK)
  run(
    @Body() dto: RunShopifySyncDto,
    @CurrentUser() user: SupabaseJwtPayload,
    @Headers('user-agent') userAgent?: string,
  ): Promise<ShopifySyncRunResult> {
    return this.admin.run(dto.instructorId, toActor(user, userAgent));
  }

  @Get('instructors/:id')
  instructor(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ): Promise<InstructorShopifySyncStatus> {
    return this.admin.instructor(id);
  }
}
