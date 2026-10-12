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
  CreatePayRateDto,
  ListPayRatesQueryDto,
  ResolvePayRateQueryDto,
  UpdatePayRateDto,
} from './dto/pay-rate.dto';
import {
  type PayRate,
  PayRatesService,
  type ResolvedPayRate,
} from './pay-rates.service';

@Controller('admin/pay-rates')
@UseGuards(SupabaseAuthGuard, RolesGuard)
@Roles('admin')
export class PayRatesController {
  constructor(private readonly payRates: PayRatesService) {}

  @Get()
  list(@Query() query: ListPayRatesQueryDto): Promise<PayRate[]> {
    return this.payRates.list({
      lessonTypeId: query.lessonTypeId,
      instructorId: query.instructorId,
      scope: query.scope,
    });
  }

  @Get('resolve')
  resolve(@Query() query: ResolvePayRateQueryDto): Promise<ResolvedPayRate> {
    return this.payRates.resolve(
      query.instructorId,
      query.lessonTypeId,
      query.date,
    );
  }

  @Post()
  create(
    @Body() dto: CreatePayRateDto,
    @CurrentUser() user: SupabaseJwtPayload,
    @Headers('user-agent') userAgent?: string,
  ): Promise<PayRate> {
    return this.payRates.create(dto, toActor(user, userAgent));
  }

  @Patch(':id')
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdatePayRateDto,
    @CurrentUser() user: SupabaseJwtPayload,
    @Headers('user-agent') userAgent?: string,
  ): Promise<PayRate> {
    return this.payRates.update(id, dto, toActor(user, userAgent));
  }
}
