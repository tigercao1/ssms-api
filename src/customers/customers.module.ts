import { Module } from '@nestjs/common';
import { ShopifyModule } from '../shopify/shopify.module';
import { CustomerReconcileService } from './customer-reconcile.service';
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
import {
  ShopifyWebhookEventsRepository,
  SupabaseShopifyWebhookEventsRepository,
} from './shopify-webhook-events.repository';

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
    {
      provide: ShopifyWebhookEventsRepository,
      useClass: SupabaseShopifyWebhookEventsRepository,
    },
    CustomerSyncService,
    CustomerReconcileService,
    CustomerSyncWorker,
    CustomersService,
  ],
  exports: [CustomersRepository, ShopifyWebhookEventsRepository],
})
export class CustomersModule {}
