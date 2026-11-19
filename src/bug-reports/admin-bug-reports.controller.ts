import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Roles, RolesGuard } from '../admin/roles.guard';
import { toActor } from '../audit/admin-actor';
import { CurrentUser } from '../auth/current-user.decorator';
import type { SupabaseJwtPayload } from '../auth/jwt-payload.interface';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { BugReportsService } from './bug-reports.service';
import type { BugReportDetail, BugReportItem } from './bug-reports.types';
import { BugReportsQueryDto, UpdateBugReportDto } from './dto/bug-report.dto';

@Controller('admin/bug-reports')
@UseGuards(SupabaseAuthGuard, RolesGuard)
@Roles('admin')
export class AdminBugReportsController {
  constructor(private readonly reports: BugReportsService) {}

  @Get()
  list(
    @Query() query: BugReportsQueryDto,
  ): Promise<{ items: BugReportItem[]; total: number }> {
    return this.reports.list(query);
  }

  @Get(':id')
  detail(
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<BugReportDetail> {
    return this.reports.detail(id);
  }

  @Patch(':id')
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateBugReportDto,
    @CurrentUser() user: SupabaseJwtPayload,
    @Headers('user-agent') userAgent?: string,
  ): Promise<BugReportDetail> {
    return this.reports.update(id, dto, toActor(user, userAgent));
  }
}
