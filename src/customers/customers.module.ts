import { Module } from '@nestjs/common';
import { ShopifyModule } from '../shopify/shopify.module';
import {
  CustomerSyncStatusRepository,
  SupabaseCustomerSyncStatusRepository,
} from './customer-sync-status.repository';
import { CustomerSyncService } from './customer-sync.service';
import { CustomerSyncWorker } from './customer-sync.worker';
import { CustomersController } from './customers.controller';
import {
  CustomersRepository,
  SupabaseCustomersRepository,
} from './customers.repository';
import { CustomersService } from './customers.service';
import { ShopifyCustomerDirectory } from './shopify-customers';

@Module({
  imports: [ShopifyModule],
  controllers: [CustomersController],
  providers: [
    { provide: CustomersRepository, useClass: SupabaseCustomersRepository },
    ShopifyCustomerDirectory,
    {
      provide: CustomerSyncStatusRepository,
      useClass: SupabaseCustomerSyncStatusRepository,
    },
    CustomerSyncService,
    CustomerSyncWorker,
    CustomersService,
  ],
})
export class CustomersModule {}
