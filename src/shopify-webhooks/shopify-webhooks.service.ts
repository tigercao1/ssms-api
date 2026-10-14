import { Injectable, Logger } from '@nestjs/common';
import {
  CustomersRepository,
  type CustomerUpsertOutcome,
} from '../customers/customers.repository';
import { toCustomerUpsert } from '../customers/customers.types';
import {
  fromWebhookPayload,
  webhookCustomerId,
} from '../customers/shopify-customers';
import { ShopifyWebhookEventsRepository } from '../customers/shopify-webhook-events.repository';
import { ShopifyError } from '../shopify/shopify.errors';

export const CUSTOMER_TOPICS = [
  'customers/create',
  'customers/update',
  'customers/delete',
] as const;

export type ShopifyWebhookOutcome =
  | CustomerUpsertOutcome
  | 'deleted'
  | 'unchanged'
  | 'duplicate'
  | 'invalid'
  | 'ignored';

export interface ShopifyWebhookDelivery {
  topic: string;
  webhookId: string;
  triggeredAt: string | null;
  payload: unknown;
}

function isCustomerTopic(topic: string): boolean {
  return (CUSTOMER_TOPICS as readonly string[]).includes(topic);
}

function customerIdOf(payload: unknown): number | null {
  try {
    return webhookCustomerId(payload);
  } catch {
    return null;
  }
}

@Injectable()
export class ShopifyWebhooksService {
  private readonly logger = new Logger(ShopifyWebhooksService.name);

  constructor(
    private readonly customers: CustomersRepository,
    private readonly events: ShopifyWebhookEventsRepository,
  ) {}

  async handle(
    delivery: ShopifyWebhookDelivery,
  ): Promise<ShopifyWebhookOutcome> {
    if (!isCustomerTopic(delivery.topic)) {
      this.logger.log(`Ignored Shopify webhook topic ${delivery.topic}`);
      return 'ignored';
    }
    const claim = await this.events.claim({
      webhook_id: delivery.webhookId,
      topic: delivery.topic,
      shopify_customer_id: customerIdOf(delivery.payload),
      triggered_at: delivery.triggeredAt,
    });
    if (claim === 'processed') {
      return 'duplicate';
    }
    let outcome: ShopifyWebhookOutcome;
    try {
      outcome = await this.apply(delivery);
    } catch (err) {
      if (err instanceof ShopifyError) {
        this.logger.warn(
          `Shopify webhook ${delivery.webhookId} (${delivery.topic}) is invalid: ${err.message}`,
        );
        await this.events.finish(delivery.webhookId, err.message);
        return 'invalid';
      }
      await this.events
        .fail(delivery.webhookId, (err as Error).message ?? String(err))
        .catch(() => undefined);
      throw err;
    }
    await this.events.finish(delivery.webhookId, null);
    return outcome;
  }

  private async apply(
    delivery: ShopifyWebhookDelivery,
  ): Promise<ShopifyWebhookOutcome> {
    if (delivery.topic === 'customers/delete') {
      const deleted = await this.customers.markDeletedInShopify(
        webhookCustomerId(delivery.payload),
        delivery.triggeredAt ?? new Date().toISOString(),
      );
      return deleted ? 'deleted' : 'unchanged';
    }
    return this.customers.upsertIfNewer(
      toCustomerUpsert(fromWebhookPayload(delivery.payload)),
    );
  }
}
