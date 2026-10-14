import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
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
import { TOTAL_COUNT_HEADER } from '../config/cors';
import {
  CustomerSyncService,
  type CustomerSyncResult,
} from './customer-sync.service';
import {
  CustomerSyncWorker,
  type CustomerSyncStatus,
} from './customer-sync.worker';
import { CustomersService } from './customers.service';
import type { Customer } from './customers.types';
import {
  CreateCustomerDto,
  SearchCustomersQueryDto,
  SyncCustomersDto,
} from './dto/customers.dto';

@Controller('admin/customers')
@UseGuards(SupabaseAuthGuard, RolesGuard)
@Roles('admin')
export class CustomersController {
  constructor(
    private readonly customers: CustomersService,
    private readonly customerSync: CustomerSyncService,
    private readonly customerSyncWorker: CustomerSyncWorker,
  ) {}

  @Get()
  async search(
    @Query() query: SearchCustomersQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Customer[]> {
    const { customers, total } = await this.customers.search(
      query.q,
      query.limit,
      query.page,
    );
    res.setHeader(TOTAL_COUNT_HEADER, String(total));
    return customers;
  }

  @Get('sync-status')
  syncStatus(): Promise<CustomerSyncStatus> {
    return this.customerSyncWorker.status();
  }

  @Post()
  create(
    @Body() dto: CreateCustomerDto,
    @CurrentUser() user: SupabaseJwtPayload,
    @Headers('user-agent') userAgent?: string,
  ): Promise<Customer> {
    return this.customers.create(dto, toActor(user, userAgent));
  }

  @Post('sync')
  @HttpCode(HttpStatus.OK)
  sync(
    @Body() dto: SyncCustomersDto,
    @CurrentUser() user: SupabaseJwtPayload,
    @Headers('user-agent') userAgent?: string,
  ): Promise<CustomerSyncResult> {
    return this.customerSync.sync(toActor(user, userAgent), {
      full: dto.full,
      cursor: dto.cursor,
    });
  }
}
