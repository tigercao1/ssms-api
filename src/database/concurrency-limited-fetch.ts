export const MAX_CONCURRENT_REQUESTS_ENV = 'SUPABASE_MAX_CONCURRENT_REQUESTS';

export function parseMaxConcurrentRequests(
  raw: string | undefined,
): number | null {
  const value = raw?.trim();
  if (!value) {
    return null;
  }
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error(
      `${MAX_CONCURRENT_REQUESTS_ENV} must be a positive integer, got "${value}"`,
    );
  }
  return Number(value);
}

export function concurrencyLimitedFetch(
  max: number,
  fetchImpl: typeof fetch = fetch,
): typeof fetch {
  let active = 0;
  const waiting: (() => void)[] = [];

  const acquire = (): Promise<void> => {
    if (active < max) {
      active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => waiting.push(resolve));
  };
  const release = (): void => {
    const next = waiting.shift();
    if (next) {
      next();
    } else {
      active -= 1;
    }
  };

  return async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    await acquire();
    try {
      return await fetchImpl(input, init);
    } finally {
      release();
    }
  };
}
