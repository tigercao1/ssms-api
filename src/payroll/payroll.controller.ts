import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { Roles, RolesGuard } from '../admin/roles.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { SupabaseJwtPayload } from '../auth/jwt-payload.interface';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { toActor } from '../audit/admin-actor';
import {
  CreatePayrollAdjustmentDto,
  ExportPayrollQueryDto,
  FinalizePayrollPeriodDto,
  ListPayrollPeriodsQueryDto,
  UpdatePayrollSettingsDto,
} from './dto/payroll.dto';
import {
  type PayrollAdjustment,
  type PayrollPeriod,
  type PayrollPeriodDetail,
  PayrollService,
  type PayrollSettings,
} from './payroll.service';

const uuid = () => new ParseUUIDPipe();

@Controller('admin/payroll')
@UseGuards(SupabaseAuthGuard, RolesGuard)
@Roles('admin')
export class PayrollController {
  constructor(private readonly payroll: PayrollService) {}

  @Get('settings')
  settings(): Promise<PayrollSettings> {
    return this.payroll.settings();
  }

  @Put('settings')
  updateSettings(
    @Body() dto: UpdatePayrollSettingsDto,
    @CurrentUser() user: SupabaseJwtPayload,
    @Headers('user-agent') userAgent?: string,
  ): Promise<PayrollSettings> {
    return this.payroll.updateSettings(
      dto.anchorDate,
      toActor(user, userAgent),
    );
  }

  @Get('periods')
  periods(
    @Query() query: ListPayrollPeriodsQueryDto,
  ): Promise<PayrollPeriod[]> {
    return this.payroll.listPeriods(query.around);
  }

  @Get('periods/:id')
  detail(@Param('id', uuid()) id: string): Promise<PayrollPeriodDetail> {
    return this.payroll.detail(id);
  }

  @Get('periods/:id/export.csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  @Header('X-Content-Type-Options', 'nosniff')
  async export(
    @Param('id', uuid()) id: string,
    @Query() query: ExportPayrollQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    const file = await this.payroll.export(id, query.detail === '1');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${file.filename}"`,
    );
    return file.body;
  }

  @Post('periods/:id/adjustments')
  addAdjustment(
    @Param('id', uuid()) id: string,
    @Body() dto: CreatePayrollAdjustmentDto,
    @CurrentUser() user: SupabaseJwtPayload,
    @Headers('user-agent') userAgent?: string,
  ): Promise<PayrollAdjustment> {
    return this.payroll.addAdjustment(id, dto, toActor(user, userAgent));
  }

  @Delete('periods/:id/adjustments/:adjustmentId')
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteAdjustment(
    @Param('id', uuid()) id: string,
    @Param('adjustmentId', uuid()) adjustmentId: string,
    @CurrentUser() user: SupabaseJwtPayload,
    @Headers('user-agent') userAgent?: string,
  ): Promise<void> {
    return this.payroll.deleteAdjustment(
      id,
      adjustmentId,
      toActor(user, userAgent),
    );
  }

  @Post('periods/:id/finalize')
  @HttpCode(HttpStatus.OK)
  finalize(
    @Param('id', uuid()) id: string,
    @Body() dto: FinalizePayrollPeriodDto,
    @CurrentUser() user: SupabaseJwtPayload,
    @Headers('user-agent') userAgent?: string,
  ): Promise<PayrollPeriodDetail> {
    return this.payroll.finalize(id, dto, toActor(user, userAgent));
  }

  @Post('periods/:id/reopen')
  @HttpCode(HttpStatus.OK)
  reopen(
    @Param('id', uuid()) id: string,
    @CurrentUser() user: SupabaseJwtPayload,
    @Headers('user-agent') userAgent?: string,
  ): Promise<PayrollPeriodDetail> {
    return this.payroll.reopen(id, toActor(user, userAgent));
  }
}
