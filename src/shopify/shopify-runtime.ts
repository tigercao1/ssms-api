export interface ShopifyRuntime {
  fetch: typeof fetch;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export const SHOPIFY_RUNTIME = Symbol('SHOPIFY_RUNTIME');

export const defaultShopifyRuntime: ShopifyRuntime = {
  fetch: (input: string | URL | Request, init?: RequestInit) =>
    fetch(input, init),
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};
