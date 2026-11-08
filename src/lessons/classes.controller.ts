import { Controller, Get, Header, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { Roles, RolesGuard } from '../admin/roles.guard';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { TOTAL_COUNT_HEADER } from '../config/cors';
import type { ClassFilter } from './classes.repository';
import { type AdminClass, ClassesService } from './classes.service';
import {
  ClassFiltersQueryDto,
  ListClassesQueryDto,
} from './dto/list-classes-query.dto';

function classFilter(query: ClassFiltersQueryDto): ClassFilter {
  return {
    from: query.from,
    to: query.to,
    instructorId: query.instructorId,
    q: query.q,
    statuses: query.status,
    lessonTypeId: query.lessonTypeId,
    locationId: query.locationId,
    createdFrom: query.createdFrom,
    createdTo: query.createdTo,
  };
}

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
      classFilter(query),
      query.page,
      query.limit,
      query.sort,
    );
    res.setHeader(TOTAL_COUNT_HEADER, String(total));
    return classes;
  }

  @Get('export')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  @Header('X-Content-Type-Options', 'nosniff')
  async export(
    @Query() query: ClassFiltersQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    const file = await this.classes.export(classFilter(query), query.sort);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${file.filename}"`,
    );
    return file.body;
  }
}
