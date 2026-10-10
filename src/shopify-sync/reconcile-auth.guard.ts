import {
  CanActivate,
  ExecutionContext,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { lastValueFrom, type Observable } from 'rxjs';
import { RolesGuard } from '../admin/roles.guard';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';

@Injectable()
export class ReconcileAuthGuard implements CanActivate {
  constructor(
    private readonly config: ConfigService,
    private readonly jwtGuard: SupabaseAuthGuard,
    private readonly rolesGuard: RolesGuard,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const secret = this.config.get<string>('SHOPIFY_RECONCILE_TOKEN')?.trim();
    if (!secret) {
      throw new NotFoundException();
    }
    const request = context.switchToHttp().getRequest<Request>();
    const presented = bearerToken(request.headers.authorization);
    if (presented !== null && sameSecret(presented, secret)) {
      return true;
    }
    const authenticated = await resolve(this.jwtGuard.canActivate(context));
    return authenticated && this.rolesGuard.canActivate(context);
  }
}

function bearerToken(header: string | undefined): string | null {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header ?? '');
  return match ? match[1] : null;
}

function sameSecret(presented: string, secret: string): boolean {
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(presented), digest(secret));
}

function resolve(
  result: boolean | Promise<boolean> | Observable<boolean>,
): Promise<boolean> {
  return typeof result === 'boolean'
    ? Promise.resolve(result)
    : result instanceof Promise
      ? result
      : lastValueFrom(result);
}
