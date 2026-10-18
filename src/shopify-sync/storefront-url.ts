import type { ConfigService } from '@nestjs/config';

export function storefrontBaseUrl(
  config: ConfigService,
  key: string,
  fallback: string,
): string {
  const base = config.get<string>(key)?.trim() || fallback;
  return base.endsWith('/') ? base : `${base}/`;
}
