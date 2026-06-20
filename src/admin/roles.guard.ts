import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Optional,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { SupabaseJwtPayload } from '../auth/jwt-payload.interface';
import { AuditService } from '../audit/audit.service';
import { AUDIT_ACTIONS } from '../audit/audit.types';

/** Metadata key carrying the roles required by a route/controller. */
export const ROLES_KEY = 'roles';

/**
 * Declares the role(s) allowed to hit a handler/controller. Read by
 * {@link RolesGuard}. When absent the guard defaults to requiring `admin`,
 * which is the posture for the whole Admin module.
 *
 *   @Roles('admin')
 *   @UseGuards(SupabaseAuthGuard, RolesGuard)
 */
export const Roles = (...roles: string[]) => SetMetadata(ROLES_KEY, roles);

/**
 * T6.1 — Admin role gate.
 *
 * Reads the role from the *verified* JWT (`app_metadata.role`). Per
 * ADMIN_ROLE_PLAN.md, `app_metadata` is **server-set only** — instructors
 * cannot self-promote by editing `user_metadata`, so we deliberately ignore it
 * here. Must run AFTER `SupabaseAuthGuard` so `request.user` is populated.
 *
 * Non-admin (or anonymous) → 403. On failure we call {@link onAdminGuardFailure}
 * — the wiring point for the `auth.admin_guard_failure` audit event, which the
 * integration agent connects in T6.8 (it is intentionally a no-op until then,
 * so this module carries no dependency on the audit module).
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    // Optional so the guard stays usable without the audit module wired (e.g.
    // unit tests that instantiate it directly); when present, every rejected
    // admin request is recorded as an abuse signal (T6.8).
    @Optional() private readonly audit?: AuditService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]) ?? ['admin'];

    const request = context.switchToHttp().getRequest<Request>();
    const user = request.user as SupabaseJwtPayload | undefined;
    const role = user?.app_metadata?.role;

    if (typeof role === 'string' && required.includes(role)) {
      return true;
    }

    this.onAdminGuardFailure(context, user);
    throw new ForbiddenException('Admin role required');
  }

  /**
   * Hook fired on every rejected admin request (T6.8). Appends an
   * `auth.admin_guard_failure` row to `audit_log` as an abuse signal. The write
   * is fire-and-forget (the guard stays synchronous) and best-effort inside
   * {@link AuditService}, so it can never block or fail the 403 response.
   */
  protected onAdminGuardFailure(
    context: ExecutionContext,
    user?: SupabaseJwtPayload,
  ): void {
    if (!this.audit) {
      return;
    }
    const request = context.switchToHttp().getRequest<Request>();
    const claimedRole = user?.app_metadata?.role;
    void this.audit.record({
      action: AUDIT_ACTIONS.authAdminGuardFailure,
      actor: {
        userId: user?.sub ?? null,
        role: claimedRole === 'instructor' ? 'instructor' : null,
        userAgent: request.headers?.['user-agent'] ?? null,
      },
      targetType: 'user',
      targetId: user?.sub ?? null,
      metadata: {
        path: request.url ?? null,
        method: request.method ?? null,
      },
    });
  }
}
