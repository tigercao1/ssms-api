import {
  type ExecutionContext,
  Injectable,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard, AuthModuleOptions } from '@nestjs/passport';
import type { Request } from 'express';
import type { Observable } from 'rxjs';
import { ROLES_KEY } from '../admin/roles.guard';
import {
  API_TOKEN_PREFIX,
  ApiTokenAuthenticator,
} from './api-token-authenticator';
import { SESSION_ONLY_KEY } from './session-only.decorator';

function bearerApiToken(header: unknown): string | null {
  if (typeof header !== 'string') {
    return null;
  }
  const match = /(\S+)\s+(\S+)/.exec(header);
  if (!match || match[1].toLowerCase() !== 'bearer') {
    return null;
  }
  return match[2].startsWith(API_TOKEN_PREFIX) ? match[2] : null;
}

/**
 * Protects non-public routes (T1.3). Missing/malformed/expired JWT → 401.
 * Usage: `@UseGuards(SupabaseAuthGuard)`.
 */
@Injectable()
export class SupabaseAuthGuard extends AuthGuard('supabase-jwt') {
  constructor(
    private readonly reflector: Reflector,
    @Optional() private readonly apiTokens?: ApiTokenAuthenticator,
    @Optional() options?: AuthModuleOptions,
  ) {
    super(options);
  }

  canActivate(
    context: ExecutionContext,
  ): boolean | Promise<boolean> | Observable<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const token = bearerApiToken(request.headers?.authorization);
    if (token === null) {
      return super.canActivate(context);
    }
    return this.activateWithApiToken(context, request, token);
  }

  private async activateWithApiToken(
    context: ExecutionContext,
    request: Request,
    token: string,
  ): Promise<boolean> {
    if (!this.apiTokens) {
      throw new UnauthorizedException();
    }
    const targets = [context.getHandler(), context.getClass()];
    const roles = this.reflector.getAllAndOverride<string[] | undefined>(
      ROLES_KEY,
      targets,
    );
    request.user = await this.apiTokens.authenticate(token, {
      adminRoute: roles?.includes('admin') === true,
      sessionOnly:
        this.reflector.getAllAndOverride<boolean | undefined>(
          SESSION_ONLY_KEY,
          targets,
        ) === true,
      method: request.method,
      path: request.path,
      userAgent: request.headers['user-agent'] ?? null,
    });
    return true;
  }
}
