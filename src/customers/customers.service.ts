import { Injectable, Logger } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { AUDIT_ACTIONS, type AuditActor } from '../audit/audit.types';
import { searchTokens } from '../database/db-result';
import { syncDisabled, toHttpError } from './customer-errors';
import { CustomerSyncService } from './customer-sync.service';
import { CustomersRepository } from './customers.repository';
import { type Customer, toCustomer, toCustomerUpsert } from './customers.types';
import type { CreateCustomerDto } from './dto/customers.dto';
import { CUSTOMER_SEARCH_DEFAULT_LIMIT } from './dto/customers.dto';
import {
  type ShopifyCustomer,
  ShopifyCustomerDirectory,
} from './shopify-customers';

export interface CustomerSearchPage {
  customers: Customer[];
  total: number;
}

const PHONE_LIKE = /^[+\d\s().-]+$/;
const MIN_PHONE_DIGITS = 3;

export function customerSearchTokens(q: string | undefined): string[] {
  const trimmed = (q ?? '').trim();
  const digits = trimmed.replace(/\D/g, '');
  if (PHONE_LIKE.test(trimmed) && digits.length >= MIN_PHONE_DIGITS) {
    return [digits];
  }
  return searchTokens(trimmed);
}

@Injectable()
export class CustomersService {
  private readonly logger = new Logger(CustomersService.name);

  constructor(
    private readonly repo: CustomersRepository,
    private readonly directory: ShopifyCustomerDirectory,
    private readonly sync: CustomerSyncService,
    private readonly audit: AuditService,
  ) {}

  async search(
    q: string | undefined,
    limit = CUSTOMER_SEARCH_DEFAULT_LIMIT,
    page = 1,
    includeDeleted = false,
  ): Promise<CustomerSearchPage> {
    const { rows, total } = await this.repo.search(customerSearchTokens(q), {
      limit,
      offset: (page - 1) * limit,
      includeDeleted,
    });
    return { customers: rows.map(toCustomer), total };
  }

  async create(dto: CreateCustomerDto, actor: AuditActor): Promise<Customer> {
    if (!this.sync.isEnabled()) {
      throw syncDisabled();
    }
    let created: ShopifyCustomer;
    try {
      created = await this.directory.create({
        firstName: dto.firstName,
        lastName: dto.lastName,
        ...(dto.email ? { email: dto.email } : {}),
        ...(dto.phone ? { phone: dto.phone } : {}),
      });
    } catch (err) {
      throw toHttpError(err, this.logger);
    }
    const customer = toCustomer(
      await this.repo.upsertOne(toCustomerUpsert(created)),
    );
    await this.audit.record({
      action: AUDIT_ACTIONS.customerCreate,
      actor: { ...actor, role: 'admin' },
      targetType: 'customer',
      targetId: customer.id,
      metadata: {
        shopifyCustomerId: customer.shopifyCustomerId,
        hasEmail: customer.email !== null,
        hasPhone: customer.phone !== null,
      },
    });
    return customer;
  }
}
