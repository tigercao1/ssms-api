import { check, type DbResult } from './db-result';

export const PGRST_RANGE_NOT_SATISFIABLE = 'PGRST103';
export const MAX_PAGE = 10_000;
export const MAX_PAGE_SIZE = 100;

export interface PageRequest {
  limit: number;
  offset: number;
}

export interface RowPage<T> {
  rows: T[];
  total: number;
}

export type CountedResult<T> = DbResult<T> & { count: number | null };

export function pageOffset(page: number, limit: number): number {
  return (page - 1) * limit;
}

export const DB_PAGE_SIZE = 1000;

export async function fetchAllPages<T>(
  fetchPage: (from: number, to: number) => PromiseLike<unknown>,
  action: string,
): Promise<T[]> {
  const rows: T[] = [];
  for (let offset = 0; ; offset += DB_PAGE_SIZE) {
    const { data, error } = (await fetchPage(
      offset,
      offset + DB_PAGE_SIZE - 1,
    )) as DbResult<T[]>;
    check(error, action);
    const page = data ?? [];
    rows.push(...page);
    if (page.length < DB_PAGE_SIZE) {
      return rows;
    }
  }
}
