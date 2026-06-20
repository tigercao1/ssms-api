/**
 * T10.1 — `makeFakeSupabase()` (TESTING_STRATEGY.md § Mocking pattern).
 *
 * A hand-rolled, ~chainable double for the subset of the Supabase/PostgREST
 * builder the server uses: `.from(table).select().eq().single()` /
 * `.insert()` / `.update()` / `.rpc()`. It records every call and returns
 * canned data per table so repository-level unit tests stay isolated from a
 * real database. Keep it tiny — extend only as new call shapes are needed.
 */

export interface FakeResult<T = unknown> {
  data: T | null;
  error: { message: string; code?: string } | null;
}

export interface FakeSupabaseConfig {
  /** Canned result per table for terminal reads (`single`/`maybeSingle`/await). */
  tables?: Record<string, FakeResult>;
  /** Canned result per RPC name. */
  rpcs?: Record<string, FakeResult>;
}

export interface FakeSupabase {
  client: {
    from: jest.Mock;
    rpc: jest.Mock;
  };
  /** Every `.from(table)` call, in order. */
  fromCalls: string[];
  /** Every `.insert(row)` payload, in order. */
  inserts: Array<{ table: string; row: unknown }>;
  /** Every `.update(patch)` payload, in order. */
  updates: Array<{ table: string; patch: unknown }>;
  /** Every `.rpc(name, args)` call, in order. */
  rpcCalls: Array<{ name: string; args: unknown }>;
}

export function makeFakeSupabase(
  config: FakeSupabaseConfig = {},
): FakeSupabase {
  const tables = config.tables ?? {};
  const rpcs = config.rpcs ?? {};

  const state: FakeSupabase = {
    client: { from: jest.fn(), rpc: jest.fn() },
    fromCalls: [],
    inserts: [],
    updates: [],
    rpcCalls: [],
  };

  state.client.from.mockImplementation((table: string) => {
    state.fromCalls.push(table);
    const result: FakeResult = tables[table] ?? { data: null, error: null };

    // Every query method returns the same chainable; terminal awaits resolve
    // to the canned result for the table.
    const builder: Record<string, unknown> = {};
    const chain = () => builder;
    for (const method of [
      'select',
      'eq',
      'in',
      'or',
      'order',
      'range',
      'limit',
      'gte',
      'lte',
      'filter',
      'maybeSingle',
    ]) {
      builder[method] = jest.fn(chain);
    }
    builder.single = jest.fn().mockResolvedValue(result);
    builder.insert = jest.fn((row: unknown) => {
      state.inserts.push({ table, row });
      return {
        select: jest.fn(() => ({
          single: jest.fn().mockResolvedValue(result),
        })),
        // bare `await insert(...)` shape
        then: (resolve: (r: FakeResult) => unknown) => resolve(result),
      };
    });
    builder.update = jest.fn((patch: unknown) => {
      state.updates.push({ table, patch });
      return builder;
    });
    // Allow `await builder` to resolve to the canned result.
    (builder as { then?: unknown }).then = (
      resolve: (r: FakeResult) => unknown,
    ) => resolve(result);
    return builder;
  });

  state.client.rpc.mockImplementation((name: string, args: unknown) => {
    state.rpcCalls.push({ name, args });
    const result: FakeResult = rpcs[name] ?? { data: null, error: null };
    return Promise.resolve(result);
  });

  return state;
}
