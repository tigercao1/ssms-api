import {
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Roles, RolesGuard } from '../admin/roles.guard';
import type { AuditActor } from '../audit/audit.types';
import { CurrentUser } from '../auth/current-user.decorator';
import type { SupabaseJwtPayload } from '../auth/jwt-payload.interface';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import {
  LessonProductSyncService,
  type LessonProductSyncResult,
} from './lesson-product-sync.service';

export function toActor(
  user: SupabaseJwtPayload,
  userAgent?: string,
): AuditActor {
  return { userId: user.sub, role: 'admin', userAgent: userAgent ?? null };
}

@Controller('admin/lesson-products')
@UseGuards(SupabaseAuthGuard, RolesGuard)
@Roles('admin')
export class LessonProductsController {
  constructor(private readonly productSync: LessonProductSyncService) {}

  @Post('sync')
  @HttpCode(HttpStatus.OK)
  sync(
    @CurrentUser() user: SupabaseJwtPayload,
    @Headers('user-agent') userAgent?: string,
  ): Promise<LessonProductSyncResult> {
    return this.productSync.sync(toActor(user, userAgent));
  }
}
