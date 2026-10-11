import type { SupabaseClient } from '@supabase/supabase-js';

export interface DbResult {
  data: unknown;
  error: { code?: string; message?: string; status?: number } | null;
}

export interface RecordedQuery {
  table: string;
  ops: Array<[string, unknown[]]>;
}

const TERMINAL = new Set(['maybeSingle', 'single']);

/** Records every query-builder call; each `from()` consumes the next queued result. */
export class FakeSupabase {
  queries: RecordedQuery[] = [];
  queue: DbResult[] = [];
  rpcCalls: Array<{ name: string; params: unknown }> = [];
  rpcResult: DbResult = { data: null, error: null };
  auth = {
    admin: {
      listUsers: jest.fn(),
      createUser: jest.fn(),
      getUserById: jest.fn(),
      generateLink: jest.fn(),
    },
  };

  from(table: string): unknown {
    const query: RecordedQuery = { table, ops: [] };
    this.queries.push(query);
    const result = this.queue.shift() ?? { data: null, error: null };
    const builder: unknown = new Proxy(
      {},
      {
        get: (_target, prop) => {
          if (prop === 'then') {
            return (
              onFulfilled: (v: DbResult) => unknown,
              onRejected: (e: unknown) => unknown,
            ) => Promise.resolve(result).then(onFulfilled, onRejected);
          }
          return (...args: unknown[]) => {
            query.ops.push([String(prop), args]);
            return TERMINAL.has(String(prop))
              ? Promise.resolve(result)
              : builder;
          };
        },
      },
    );
    return builder;
  }

  rpc(name: string, params: unknown): Promise<DbResult> {
    this.rpcCalls.push({ name, params });
    return Promise.resolve(this.rpcResult);
  }

  ops(index: number): Array<[string, unknown[]]> {
    return this.queries[index].ops;
  }

  asClient(): SupabaseClient {
    return this as unknown as SupabaseClient;
  }
}
