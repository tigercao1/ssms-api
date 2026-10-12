import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { Roles, RolesGuard } from '../admin/roles.guard';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { type AdminClass, ClassesService } from './classes.service';
import { ListClassesQueryDto } from './dto/list-classes-query.dto';

@Controller('admin/classes')
@UseGuards(SupabaseAuthGuard, RolesGuard)
@Roles('admin')
export class ClassesController {
  constructor(private readonly classes: ClassesService) {}

  @Get()
  list(@Query() query: ListClassesQueryDto): Promise<AdminClass[]> {
    return this.classes.list({
      from: query.from,
      to: query.to,
      instructorId: query.instructorId,
    });
  }
}
