import { Module } from '@nestjs/common';
import { CustomersModule } from '../customers/customers.module';
import { ShopifyWebhookThrottlerGuard } from './shopify-webhook-throttler.guard';
import { ShopifyWebhookVerifier } from './shopify-webhook.verifier';
import { ShopifyWebhooksController } from './shopify-webhooks.controller';
import { ShopifyWebhooksService } from './shopify-webhooks.service';

@Module({
  imports: [CustomersModule],
  controllers: [ShopifyWebhooksController],
  providers: [
    ShopifyWebhookVerifier,
    ShopifyWebhookThrottlerGuard,
    ShopifyWebhooksService,
  ],
})
export class ShopifyWebhooksModule {}
