import type { ConfigService } from '@nestjs/config';

/** The storefront base URL in `key` (else `fallback`), always ending in `/`. */
export function storefrontBaseUrl(
  config: ConfigService,
  key: string,
  fallback: string,
): string {
  const base = config.get<string>(key)?.trim() || fallback;
  return base.endsWith('/') ? base : `${base}/`;
}
