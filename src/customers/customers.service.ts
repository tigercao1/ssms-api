import { Injectable, Logger } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { AUDIT_ACTIONS, type AuditActor } from '../audit/audit.types';
import { searchTokens } from '../database/db-result';
import { pageOffset } from '../database/pagination';
import { waiverFor } from '../documents/waiver-year';
import { syncDisabled, toHttpError } from './customer-errors';
import { CustomerSyncService } from './customer-sync.service';
import { type CustomerRow, CustomersRepository } from './customers.repository';
import {
  type Customer,
  type CustomerWithWaiver,
  toCustomer,
  toCustomerUpsert,
} from './customers.types';
import type { CreateCustomerDto } from './dto/customers.dto';
import { CUSTOMER_SEARCH_DEFAULT_LIMIT } from './dto/customers.dto';
import {
  type ShopifyCustomer,
  ShopifyCustomerDirectory,
} from './shopify-customers';

export interface CustomerSearchPage {
  customers: CustomerWithWaiver[];
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
      offset: pageOffset(page, limit),
      includeDeleted,
    });
    return { customers: await this.withWaivers(rows), total };
  }

  async findByIds(ids: string[]): Promise<CustomerSearchPage> {
    const customers = await this.withWaivers(await this.repo.findByIds(ids));
    return { customers, total: customers.length };
  }

  private async withWaivers(
    rows: CustomerRow[],
  ): Promise<CustomerWithWaiver[]> {
    const signedAt = await this.repo.latestSignatures(rows.map((r) => r.id));
    const now = new Date();
    return rows.map((row) => ({
      ...toCustomer(row),
      waiver: waiverFor(signedAt.get(row.id) ?? null, now),
    }));
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
