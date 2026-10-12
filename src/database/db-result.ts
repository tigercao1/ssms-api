export interface DbError {
  message: string;
  code?: string;
}

export interface DbResult<T> {
  data: T | null;
  error: DbError | null;
}

export const PG_UNIQUE_VIOLATION = '23505';
export const PG_FOREIGN_KEY_VIOLATION = '23503';
export const PG_CHECK_VIOLATION = '23514';
export const PG_EXCLUSION_VIOLATION = '23P01';

export class DatabaseError extends Error {
  constructor(
    readonly action: string,
    readonly code: string | undefined,
    detail: string,
  ) {
    super(`Failed to ${action}: ${detail}`);
    this.name = 'DatabaseError';
  }
}

export function check(error: DbError | null, action: string): void {
  if (error) {
    throw new DatabaseError(action, error.code, error.message);
  }
}

export function hasCode(err: unknown, code: string): boolean {
  return err instanceof DatabaseError && err.code === code;
}

export function likePattern(term: string): string {
  return `%${term.replace(/\*/g, '').replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export function ilikeAny(columns: string[], term: string): string {
  const quoted = `"${likePattern(term).replace(/[\\"]/g, (c) => `\\${c}`)}"`;
  return columns.map((column) => `${column}.ilike.${quoted}`).join(',');
}

export function searchTokens(q: string | undefined, maxTokens = 5): string[] {
  return (q ?? '')
    .trim()
    .split(/\s+/)
    .map((token) => token.replace(/\*/g, ''))
    .filter((token) => token.length > 0)
    .slice(0, maxTokens);
}
