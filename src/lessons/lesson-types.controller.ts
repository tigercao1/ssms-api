import {
  Body,
  Controller,
  Get,
  Headers,
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
import { toActor } from '../audit/admin-actor';
import {
  CreateLessonTypeDto,
  ListLessonTypesQueryDto,
  UpdateLessonTypeDto,
} from './dto/lesson-type.dto';
import { type LessonType, LessonTypesService } from './lesson-types.service';

@Controller('admin/lesson-types')
@UseGuards(SupabaseAuthGuard, RolesGuard)
@Roles('admin')
export class LessonTypesController {
  constructor(private readonly lessonTypes: LessonTypesService) {}

  @Get()
  list(@Query() query: ListLessonTypesQueryDto): Promise<LessonType[]> {
    return this.lessonTypes.list({ active: query.active });
  }

  @Post()
  create(
    @Body() dto: CreateLessonTypeDto,
    @CurrentUser() user: SupabaseJwtPayload,
    @Headers('user-agent') userAgent?: string,
  ): Promise<LessonType> {
    return this.lessonTypes.create(dto, toActor(user, userAgent));
  }

  @Patch(':id')
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateLessonTypeDto,
    @CurrentUser() user: SupabaseJwtPayload,
    @Headers('user-agent') userAgent?: string,
  ): Promise<LessonType> {
    return this.lessonTypes.update(id, dto, toActor(user, userAgent));
  }
}
