import { Module } from '@nestjs/common';
import { ShopifyAdminClient } from './shopify-admin.client';

@Module({
  providers: [ShopifyAdminClient],
  exports: [ShopifyAdminClient],
})
export class ShopifyModule {}
