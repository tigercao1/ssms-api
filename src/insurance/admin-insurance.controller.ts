import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Roles, RolesGuard } from '../admin/roles.guard';
import { toActor } from '../audit/admin-actor';
import { CurrentUser } from '../auth/current-user.decorator';
import type { SupabaseJwtPayload } from '../auth/jwt-payload.interface';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import {
  type AdminInsuranceRecordPage,
  AdminInsuranceService,
  type InstructorInsuranceSummary,
} from './admin-insurance.service';
import {
  AdminInsuranceRecordsQueryDto,
  InsuranceSeasonQueryDto,
  MarkPaidDto,
  VoidRecordDto,
} from './dto/insurance.dto';
import type { AdminInsuranceRecord } from './insurance.presenters';

const uuid = () => new ParseUUIDPipe();

@Controller('admin/insurance')
@UseGuards(SupabaseAuthGuard, RolesGuard)
@Roles('admin')
export class AdminInsuranceController {
  constructor(private readonly insurance: AdminInsuranceService) {}

  @Get('summary')
  summary(
    @Query() query: InsuranceSeasonQueryDto,
  ): Promise<InstructorInsuranceSummary[]> {
    return this.insurance.summary(query.season);
  }

  @Get('records')
  records(
    @Query() query: AdminInsuranceRecordsQueryDto,
  ): Promise<AdminInsuranceRecordPage> {
    return this.insurance.records(query);
  }

  @Post('records/:id/mark-paid')
  @HttpCode(HttpStatus.OK)
  markPaid(
    @Param('id', uuid()) id: string,
    @Body() dto: MarkPaidDto,
    @CurrentUser() user: SupabaseJwtPayload,
    @Headers('user-agent') userAgent?: string,
  ): Promise<AdminInsuranceRecord> {
    return this.insurance.markPaid(id, dto, toActor(user, userAgent));
  }

  @Post('records/:id/mark-unpaid')
  @HttpCode(HttpStatus.OK)
  markUnpaid(
    @Param('id', uuid()) id: string,
    @CurrentUser() user: SupabaseJwtPayload,
    @Headers('user-agent') userAgent?: string,
  ): Promise<AdminInsuranceRecord> {
    return this.insurance.markUnpaid(id, toActor(user, userAgent));
  }

  @Post('records/:id/void')
  @HttpCode(HttpStatus.OK)
  void(
    @Param('id', uuid()) id: string,
    @Body() dto: VoidRecordDto,
    @CurrentUser() user: SupabaseJwtPayload,
    @Headers('user-agent') userAgent?: string,
  ): Promise<AdminInsuranceRecord> {
    return this.insurance.void(id, dto.reason, toActor(user, userAgent));
  }
}
