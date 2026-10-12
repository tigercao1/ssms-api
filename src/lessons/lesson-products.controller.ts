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
  Query,
  UseGuards,
} from '@nestjs/common';
import { Roles, RolesGuard } from '../admin/roles.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { SupabaseJwtPayload } from '../auth/jwt-payload.interface';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { toActor } from './admin-actor';
import { ListLessonProductsQueryDto } from './dto/list-lesson-products-query.dto';
import { UpdateLessonProductDto } from './dto/update-lesson-product.dto';
import {
  LessonProductSyncService,
  type LessonProductSyncResult,
} from './lesson-product-sync.service';
import { LessonProductsService } from './lesson-products.service';
import type { LessonProduct } from './lessons.types';

@Controller('admin/lesson-products')
@UseGuards(SupabaseAuthGuard, RolesGuard)
@Roles('admin')
export class LessonProductsController {
  constructor(
    private readonly products: LessonProductsService,
    private readonly productSync: LessonProductSyncService,
  ) {}

  @Get()
  list(@Query() query: ListLessonProductsQueryDto): Promise<LessonProduct[]> {
    return this.products.list(query.status);
  }

  @Patch(':id')
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateLessonProductDto,
    @CurrentUser() user: SupabaseJwtPayload,
    @Headers('user-agent') userAgent?: string,
  ): Promise<LessonProduct> {
    return this.products.update(id, dto, toActor(user, userAgent));
  }

  @Post('sync')
  @HttpCode(HttpStatus.OK)
  sync(
    @CurrentUser() user: SupabaseJwtPayload,
    @Headers('user-agent') userAgent?: string,
  ): Promise<LessonProductSyncResult> {
    return this.productSync.sync(toActor(user, userAgent));
  }
}
