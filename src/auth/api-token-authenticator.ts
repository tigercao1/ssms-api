import type { SupabaseJwtPayload } from './jwt-payload.interface';

export const API_TOKEN_PREFIX = 'ssms_pat_';
const WELL_FORMED_API_TOKEN = /^ssms_pat_[A-Za-z0-9_-]{43}$/;

export function isWellFormedApiToken(token: string): boolean {
  return WELL_FORMED_API_TOKEN.test(token);
}

export interface ApiTokenRoute {
  adminRoute: boolean;
  sessionOnly: boolean;
  method: string;
  path: string;
  userAgent: string | null;
}

export abstract class ApiTokenAuthenticator {
  abstract authenticate(
    token: string,
    route: ApiTokenRoute,
  ): Promise<SupabaseJwtPayload>;
}
