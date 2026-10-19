export const POSTGREST_MAX_ROWS = 1000;

type Row = Record<string, unknown>;

export interface CappedRequest {
  table: string;
  range?: [number, number];
}

function sortKey(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number'
    ? String(value)
    : '';
}

function compareValues(a: unknown, b: unknown): number {
  const left = sortKey(a);
  const right = sortKey(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

export function cappedSupabase(tables: Record<string, readonly object[]>) {
  const requests: CappedRequest[] = [];
  const client = {
    from(table: string) {
      let rows = [...(tables[table] ?? [])] as Row[];
      const sorts: { column: string; ascending: boolean }[] = [];
      let range: [number, number] | undefined;
      let counted = false;
      const builder = {
        select(_columns: string, options?: { count?: 'exact' }) {
          counted = options?.count === 'exact';
          return builder;
        },
        eq(column: string, value: unknown) {
          rows = rows.filter((row) => row[column] === value);
          return builder;
        },
        not(column: string, _operator: 'eq', value: unknown) {
          rows = rows.filter((row) => row[column] !== value);
          return builder;
        },
        in(column: string, values: readonly unknown[]) {
          rows = rows.filter((row) => values.includes(row[column]));
          return builder;
        },
        order(column: string, { ascending }: { ascending: boolean }) {
          sorts.push({ column, ascending });
          return builder;
        },
        range(from: number, to: number) {
          range = [from, to];
          return builder;
        },
        then<R>(
          resolve: (result: {
            data: Row[];
            error: null;
            count: number | null;
          }) => R,
          reject?: (reason: unknown) => R,
        ) {
          requests.push({ table, range });
          const sorted = [...rows].sort((a, b) => {
            for (const { column, ascending } of sorts) {
              const order = compareValues(a[column], b[column]);
              if (order !== 0) {
                return ascending ? order : -order;
              }
            }
            return 0;
          });
          const window = range ? sorted.slice(range[0], range[1] + 1) : sorted;
          return Promise.resolve({
            data: window.slice(0, POSTGREST_MAX_ROWS),
            error: null,
            count: counted ? rows.length : null,
          }).then(resolve, reject);
        },
      };
      return builder;
    },
  };
  return { client, requests };
}
