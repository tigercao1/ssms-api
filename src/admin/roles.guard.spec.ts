import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from './roles.guard';

function makeContext(user: unknown): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        user,
        url: '/admin/instructors',
        method: 'GET',
        headers: { 'user-agent': 'jest-agent' },
      }),
    }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as unknown as ExecutionContext;
}

describe('RolesGuard', () => {
  let reflector: Reflector;
  let guard: RolesGuard;

  beforeEach(() => {
    reflector = new Reflector();
    // Default the route requirement to ['admin'].
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(undefined);
    guard = new RolesGuard(reflector);
  });

  it('allows a user whose app_metadata.role is admin', () => {
    const ctx = makeContext({ app_metadata: { role: 'admin' } });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('rejects a non-admin (instructor) with 403', () => {
    const ctx = makeContext({ app_metadata: { role: 'instructor' } });
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('rejects when there is no role claim', () => {
    const ctx = makeContext({ app_metadata: {} });
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('rejects an anonymous request (no user)', () => {
    const ctx = makeContext(undefined);
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('ignores a self-set user_metadata.role (server-set app_metadata only)', () => {
    const ctx = makeContext({
      app_metadata: { role: 'instructor' },
      user_metadata: { role: 'admin' },
    });
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('honours an explicit @Roles requirement from metadata', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['superadmin']);
    const adminCtx = makeContext({ app_metadata: { role: 'admin' } });
    expect(() => guard.canActivate(adminCtx)).toThrow(ForbiddenException);

    const superCtx = makeContext({ app_metadata: { role: 'superadmin' } });
    expect(guard.canActivate(superCtx)).toBe(true);
  });

  it('writes an auth.admin_guard_failure audit row on rejection (T6.8)', () => {
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const wired = new RolesGuard(reflector, audit as never);
    const ctx = makeContext({
      sub: 'user-9',
      app_metadata: { role: 'instructor' },
    });

    expect(() => wired.canActivate(ctx)).toThrow(ForbiddenException);
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'auth.admin_guard_failure',
        targetType: 'user',
        targetId: 'user-9',
        actor: {
          userId: 'user-9',
          role: 'instructor',
          userAgent: 'jest-agent',
        },
        metadata: { path: '/admin/instructors', method: 'GET' },
      }),
    );
  });

  it('stays silent (no throw) when no audit service is wired', () => {
    const ctx = makeContext({ app_metadata: { role: 'instructor' } });
    // guard built without AuditService → onAdminGuardFailure is a safe no-op
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('invokes the onAdminGuardFailure hook on rejection (T6.8 seam)', () => {
    const hook = jest.fn();
    class HookedGuard extends RolesGuard {
      protected onAdminGuardFailure(): void {
        hook();
      }
    }
    const hooked = new HookedGuard(reflector);
    const ctx = makeContext({ app_metadata: { role: 'instructor' } });
    expect(() => hooked.canActivate(ctx)).toThrow(ForbiddenException);
    expect(hook).toHaveBeenCalledTimes(1);
  });
});
