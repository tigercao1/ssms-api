import { Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { Roles, RolesGuard } from '../admin/roles.guard';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { TOTAL_COUNT_HEADER } from '../config/cors';
import { type AdminClass, ClassesService } from './classes.service';
import { ListClassesQueryDto } from './dto/list-classes-query.dto';

@Controller('admin/classes')
@UseGuards(SupabaseAuthGuard, RolesGuard)
@Roles('admin')
export class ClassesController {
  constructor(private readonly classes: ClassesService) {}

  @Get()
  async list(
    @Query() query: ListClassesQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AdminClass[]> {
    const { classes, total } = await this.classes.list(
      {
        from: query.from,
        to: query.to,
        instructorId: query.instructorId,
      },
      query.page,
      query.limit,
    );
    res.setHeader(TOTAL_COUNT_HEADER, String(total));
    return classes;
  }
}
