import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { SupabaseJwtPayload } from './jwt-payload.interface';

/**
 * Injects the verified JWT payload (T1.4). Requires SupabaseAuthGuard upstream.
 *   handler(@CurrentUser() user: SupabaseJwtPayload) { ... }
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): SupabaseJwtPayload => {
    const req = context.switchToHttp().getRequest<Request>();
    return req.user as SupabaseJwtPayload;
  },
);
