import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
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
  CustomerSyncService,
  type CustomerSyncResult,
} from './customer-sync.service';
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
  ) {}

  @Get()
  search(@Query() query: SearchCustomersQueryDto): Promise<Customer[]> {
    return this.customers.search(query.q, query.limit);
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
