import {
  type ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard, AuthModuleOptions } from '@nestjs/passport';
import type { Request, Response } from 'express';
import { clientIp } from '../activation/activation-throttler.guard';
import { ROLES_KEY } from '../admin/roles.guard';
import {
  API_TOKEN_PREFIX,
  ApiTokenAuthenticator,
  isWellFormedApiToken,
} from './api-token-authenticator';
import { AuthFailureLimiter } from './auth-failure-limiter';
import { SESSION_ONLY_KEY } from './session-only.decorator';

const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

function bearerCredential(header: unknown): string | null {
  if (typeof header !== 'string') {
    return null;
  }
  const match = /(\S+)\s+(\S+)/.exec(header);
  if (!match || match[1].toLowerCase() !== 'bearer') {
    return null;
  }
  return match[2];
}

function worthVerifying(credential: string | null): boolean {
  if (credential === null) {
    return false;
  }
  return credential.startsWith(API_TOKEN_PREFIX)
    ? isWellFormedApiToken(credential)
    : JWT_SHAPE.test(credential);
}

/**
 * Protects non-public routes (T1.3). Bad credential → 401; failure bursts → 429.
 * Usage: `@UseGuards(SupabaseAuthGuard)`.
 */
@Injectable()
export class SupabaseAuthGuard extends AuthGuard('supabase-jwt') {
  constructor(
    private readonly reflector: Reflector,
    @Optional() private readonly apiTokens?: ApiTokenAuthenticator,
    @Optional() options?: AuthModuleOptions,
    @Optional() private readonly failures?: AuthFailureLimiter,
  ) {
    super(options);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const credential = bearerCredential(request.headers?.authorization);
    const ip = clientIp(request);
    if (this.failures && !worthVerifying(credential)) {
      const retryAfter = this.failures.retryAfterSeconds(ip);
      if (retryAfter !== null) {
        throw tooManyFailures(context, retryAfter);
      }
    }
    try {
      return credential?.startsWith(API_TOKEN_PREFIX)
        ? await this.activateWithApiToken(context, request, credential)
        : await (super.canActivate(context) as Promise<boolean>);
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        this.failures?.recordFailure(ip);
      }
      throw error;
    }
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

function tooManyFailures(
  context: ExecutionContext,
  retryAfterSeconds: number,
): HttpException {
  context
    .switchToHttp()
    .getResponse<Response>()
    .setHeader('Retry-After', String(retryAfterSeconds));
  return new HttpException(
    {
      statusCode: HttpStatus.TOO_MANY_REQUESTS,
      message: 'Too many failed authentication attempts from this address',
      retryAfterSeconds,
    },
    HttpStatus.TOO_MANY_REQUESTS,
  );
}
