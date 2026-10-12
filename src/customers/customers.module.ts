import { Module } from '@nestjs/common';
import { ShopifyModule } from '../shopify/shopify.module';
import { CustomerSyncService } from './customer-sync.service';
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
    CustomerSyncService,
    CustomersService,
  ],
})
export class CustomersModule {}
