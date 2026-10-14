import {
  BadRequestException,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  type RawBodyRequest,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { ShopifyWebhookThrottlerGuard } from './shopify-webhook-throttler.guard';
import {
  headerValue,
  ShopifyWebhookVerifier,
} from './shopify-webhook.verifier';
import {
  type ShopifyWebhookOutcome,
  ShopifyWebhooksService,
} from './shopify-webhooks.service';

export const WEBHOOK_ID_MISSING = 'X-Shopify-Webhook-Id is required';
export const WEBHOOK_BODY_INVALID = 'Shopify webhook body is not JSON';

function parseJson(rawBody: Buffer): unknown {
  try {
    return JSON.parse(rawBody.toString('utf8'));
  } catch {
    throw new BadRequestException(WEBHOOK_BODY_INVALID);
  }
}

function toTimestamp(value: string): string | null {
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

@Controller('webhooks')
@UseGuards(ShopifyWebhookThrottlerGuard)
export class ShopifyWebhooksController {
  constructor(
    private readonly verifier: ShopifyWebhookVerifier,
    private readonly webhooks: ShopifyWebhooksService,
  ) {}

  @Post('shopify')
  @HttpCode(HttpStatus.OK)
  async receive(
    @Req() req: RawBodyRequest<Request>,
  ): Promise<{ outcome: ShopifyWebhookOutcome }> {
    const rawBody = req.rawBody ?? Buffer.alloc(0);
    this.verifier.verify(rawBody, req.headers);
    const webhookId = headerValue(req.headers, 'x-shopify-webhook-id');
    if (!webhookId) {
      throw new BadRequestException(WEBHOOK_ID_MISSING);
    }
    const outcome = await this.webhooks.handle({
      topic: headerValue(req.headers, 'x-shopify-topic'),
      webhookId,
      triggeredAt: toTimestamp(
        headerValue(req.headers, 'x-shopify-triggered-at'),
      ),
      payload: parseJson(rawBody),
    });
    return { outcome };
  }
}
