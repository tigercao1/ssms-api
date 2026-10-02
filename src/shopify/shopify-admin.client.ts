import { Inject, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readShopifyConfig, type ShopifyConfig } from './shopify.config';
import {
  ShopifyAuthError,
  ShopifyGraphqlError,
  type ShopifyGraphqlErrorItem,
  ShopifyHttpError,
  ShopifyThrottledError,
} from './shopify.errors';
import {
  defaultShopifyRuntime,
  SHOPIFY_RUNTIME,
  type ShopifyRuntime,
} from './shopify-runtime';

export const MAX_THROTTLE_ATTEMPTS = 5;
export const MAX_TRANSPORT_ATTEMPTS = 4;
export const MAX_THROTTLE_WAIT_MS = 10_000;
export const MIN_THROTTLE_WAIT_MS = 500;
export const TRANSPORT_BACKOFF_BASE_MS = 500;
export const TOKEN_REFRESH_MARGIN_MS = 60_000;

interface ThrottleStatus {
  maximumAvailable: number;
  currentlyAvailable: number;
  restoreRate: number;
}

interface QueryCost {
  requestedQueryCost?: number;
  actualQueryCost?: number | null;
  throttleStatus?: ThrottleStatus;
}

interface GraphqlResponse<T> {
  data?: T | null;
  errors?: ShopifyGraphqlErrorItem[];
  extensions?: { cost?: QueryCost };
}

interface AccessToken {
  value: string;
  refreshAt: number;
}

interface BudgetSnapshot {
  status: ThrottleStatus;
  observedAt: number;
  lastCost: number;
}

@Injectable()
export class ShopifyAdminClient {
  private readonly runtime: ShopifyRuntime;
  private settings?: ShopifyConfig;
  private token?: AccessToken;
  private pendingToken?: Promise<AccessToken>;
  private budget?: BudgetSnapshot;

  constructor(
    private readonly configService: ConfigService,
    @Optional()
    @Inject(SHOPIFY_RUNTIME)
    runtime?: Partial<ShopifyRuntime>,
  ) {
    this.runtime = { ...defaultShopifyRuntime, ...runtime };
  }

  async graphql<T>(
    query: string,
    variables: Record<string, unknown> = {},
  ): Promise<T> {
    const config = this.config();
    for (let attempt = 1; ; attempt++) {
      await this.waitForBudget();
      const body = await this.post<T>(config, query, variables);
      const cost = body.extensions?.cost;
      this.recordCost(cost);
      const errors = body.errors ?? [];
      if (errors.some((e) => e.extensions?.code === 'THROTTLED')) {
        if (attempt >= MAX_THROTTLE_ATTEMPTS) {
          throw new ShopifyThrottledError(errors);
        }
        await this.runtime.sleep(this.throttleWait(cost));
        continue;
      }
      if (errors.length > 0) {
        throw new ShopifyGraphqlError(errors);
      }
      if (body.data == null) {
        throw new ShopifyGraphqlError([
          { message: 'Response contained no data' },
        ]);
      }
      return body.data;
    }
  }

  private config(): ShopifyConfig {
    this.settings ??= readShopifyConfig((key) =>
      this.configService.get<string>(key),
    );
    return this.settings;
  }

  private async post<T>(
    config: ShopifyConfig,
    query: string,
    variables: Record<string, unknown>,
  ): Promise<GraphqlResponse<T>> {
    const url = `https://${config.shop}.myshopify.com/admin/api/${config.apiVersion}/graphql.json`;
    let refreshedAfterUnauthorized = false;
    let attempt = 0;
    for (;;) {
      attempt++;
      const token = await this.accessToken(config);
      let response: Response;
      try {
        response = await this.runtime.fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Shopify-Access-Token': token.value,
          },
          body: JSON.stringify({ query, variables }),
        });
      } catch (err) {
        if (attempt >= MAX_TRANSPORT_ATTEMPTS) {
          throw new ShopifyHttpError(undefined, (err as Error).message, {
            cause: err,
          });
        }
        await this.runtime.sleep(transportBackoff(attempt));
        continue;
      }

      if (response.status === 401 && !refreshedAfterUnauthorized) {
        refreshedAfterUnauthorized = true;
        this.invalidateToken(token);
        attempt--;
        continue;
      }
      if (isRetryableStatus(response.status)) {
        if (attempt >= MAX_TRANSPORT_ATTEMPTS) {
          throw new ShopifyHttpError(response.status, await readText(response));
        }
        await this.runtime.sleep(transportBackoff(attempt));
        continue;
      }
      if (!response.ok) {
        throw new ShopifyHttpError(response.status, await readText(response));
      }
      return (await response.json()) as GraphqlResponse<T>;
    }
  }

  private async accessToken(config: ShopifyConfig): Promise<AccessToken> {
    if (this.token && this.runtime.now() < this.token.refreshAt) {
      return this.token;
    }
    this.pendingToken ??= this.requestToken(config).finally(() => {
      this.pendingToken = undefined;
    });
    this.token = await this.pendingToken;
    return this.token;
  }

  private invalidateToken(token: AccessToken): void {
    if (this.token === token) {
      this.token = undefined;
    }
  }

  private async requestToken(config: ShopifyConfig): Promise<AccessToken> {
    const response = await this.runtime.fetch(
      `https://${config.shop}.myshopify.com/admin/oauth/access_token`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: config.clientId,
          client_secret: config.clientSecret,
        }).toString(),
      },
    );
    if (!response.ok) {
      throw new ShopifyAuthError(response.status, await readText(response));
    }
    const body = (await response.json()) as {
      access_token?: string;
      expires_in?: number;
    };
    if (!body.access_token) {
      throw new ShopifyAuthError(response.status, 'response had no token');
    }
    const lifetimeMs = (body.expires_in ?? 0) * 1000;
    return {
      value: body.access_token,
      refreshAt:
        this.runtime.now() + Math.max(lifetimeMs - TOKEN_REFRESH_MARGIN_MS, 0),
    };
  }

  private recordCost(cost: QueryCost | undefined): void {
    if (!cost?.throttleStatus) {
      return;
    }
    this.budget = {
      status: cost.throttleStatus,
      observedAt: this.runtime.now(),
      lastCost: cost.actualQueryCost ?? cost.requestedQueryCost ?? 0,
    };
  }

  private async waitForBudget(): Promise<void> {
    if (!this.budget) {
      return;
    }
    const { status, observedAt, lastCost } = this.budget;
    const elapsedSeconds = (this.runtime.now() - observedAt) / 1000;
    const projected = Math.min(
      status.maximumAvailable,
      status.currentlyAvailable + status.restoreRate * elapsedSeconds,
    );
    if (projected >= lastCost || status.restoreRate <= 0) {
      return;
    }
    await this.runtime.sleep(
      Math.min(
        MAX_THROTTLE_WAIT_MS,
        Math.ceil(((lastCost - projected) / status.restoreRate) * 1000),
      ),
    );
  }

  private throttleWait(cost: QueryCost | undefined): number {
    const status = cost?.throttleStatus;
    if (!status || status.restoreRate <= 0) {
      return MAX_THROTTLE_WAIT_MS;
    }
    const deficit = Math.max(
      (cost.requestedQueryCost ?? 0) - status.currentlyAvailable,
      0,
    );
    const waitMs = Math.ceil((deficit / status.restoreRate) * 1000);
    return Math.min(
      MAX_THROTTLE_WAIT_MS,
      Math.max(MIN_THROTTLE_WAIT_MS, waitMs),
    );
  }
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function transportBackoff(attempt: number): number {
  return TRANSPORT_BACKOFF_BASE_MS * 2 ** (attempt - 1);
}

async function readText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 500);
  } catch {
    return '<unreadable body>';
  }
}
