export interface ShopifyGraphqlErrorItem {
  message: string;
  path?: (string | number)[];
  extensions?: { code?: string; [key: string]: unknown };
}

export interface ShopifyUserError {
  field?: string[] | null;
  message: string;
  code?: string | null;
}

export class ShopifyError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class ShopifyConfigError extends ShopifyError {
  constructor(readonly missing: string[]) {
    super(`Shopify is not configured; missing ${missing.join(', ')}.`);
  }
}

export class ShopifyAuthError extends ShopifyError {
  constructor(
    readonly status: number,
    readonly detail: string,
  ) {
    super(`Shopify access token request failed (${status}): ${detail}`);
  }
}

export class ShopifyHttpError extends ShopifyError {
  constructor(
    readonly status: number | undefined,
    readonly detail: string,
    options?: ErrorOptions,
  ) {
    super(
      `Shopify Admin API request failed (${status ?? 'network error'}): ${detail}`,
      options,
    );
  }
}

export class ShopifyGraphqlError extends ShopifyError {
  constructor(readonly errors: ShopifyGraphqlErrorItem[]) {
    super(`Shopify GraphQL errors: ${errors.map((e) => e.message).join('; ')}`);
  }
}

export class ShopifyThrottledError extends ShopifyGraphqlError {}

export class ShopifyUserErrorsError extends ShopifyError {
  constructor(
    readonly operation: string,
    readonly userErrors: ShopifyUserError[],
  ) {
    super(
      `${operation} returned user errors: ${userErrors
        .map(
          (e) => (e.field?.length ? `${e.field.join('.')}: ` : '') + e.message,
        )
        .join('; ')}`,
    );
  }
}
