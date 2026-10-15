import type { DbResult } from './db-result';

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
