import type { SupabaseJwtPayload } from './jwt-payload.interface';

export const API_TOKEN_PREFIX = 'ssms_pat_';

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
