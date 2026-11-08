import {
  concurrencyLimitedFetch,
  parseMaxConcurrentRequests,
} from './concurrency-limited-fetch';

function deferredFetch() {
  const pending: {
    resolve: (r: Response) => void;
    reject: (e: Error) => void;
  }[] = [];
  let inFlight = 0;
  let peak = 0;
  const fetchImpl = jest.fn<Promise<Response>, Parameters<typeof fetch>>(
    () =>
      new Promise<Response>((resolve, reject) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        pending.push({
          resolve: (r) => {
            inFlight -= 1;
            resolve(r);
          },
          reject: (e) => {
            inFlight -= 1;
            reject(e);
          },
        });
      }),
  );
  return { fetchImpl, pending, peak: () => peak };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

describe('parseMaxConcurrentRequests', () => {
  it('treats unset or blank as no limit', () => {
    expect(parseMaxConcurrentRequests(undefined)).toBeNull();
    expect(parseMaxConcurrentRequests(' ')).toBeNull();
  });

  it('reads a positive integer', () => {
    expect(parseMaxConcurrentRequests(' 4 ')).toBe(4);
  });

  it.each(['0', '-1', '2.5', 'four'])('refuses %s', (raw) => {
    expect(() => parseMaxConcurrentRequests(raw)).toThrow(
      'SUPABASE_MAX_CONCURRENT_REQUESTS must be a positive integer',
    );
  });
});

describe('concurrencyLimitedFetch', () => {
  it('keeps at most max requests in flight and runs the rest in order', async () => {
    const fake = deferredFetch();
    const limited = concurrencyLimitedFetch(2, fake.fetchImpl);

    const results = Promise.allSettled(
      ['a', 'b', 'c', 'd'].map((url) => limited(url)),
    );
    await settle();
    expect(fake.fetchImpl).toHaveBeenCalledTimes(2);

    fake.pending[0].resolve(new Response('a'));
    fake.pending[1].reject(new Error('b failed'));
    await settle();
    expect(fake.fetchImpl).toHaveBeenCalledTimes(4);
    expect(fake.fetchImpl.mock.calls.map((call) => call[0] as string)).toEqual([
      'a',
      'b',
      'c',
      'd',
    ]);
    fake.pending[2].resolve(new Response('c'));
    fake.pending[3].resolve(new Response('d'));

    expect((await results).map((r) => r.status)).toEqual([
      'fulfilled',
      'rejected',
      'fulfilled',
      'fulfilled',
    ]);
    expect(fake.peak()).toBe(2);
  });
});
