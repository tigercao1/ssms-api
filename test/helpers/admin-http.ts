import {
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import type { TestingModuleBuilder } from '@nestjs/testing';
import type { Request } from 'express';
import type { App } from 'supertest/types';
import { SupabaseAuthGuard } from '../../src/auth/supabase-auth.guard';

export const ADMIN_ID = '7d0f8a1e-5b2c-4e3d-9a8b-1c2d3e4f5a6b';
export const ADMIN_AUTH = 'Bearer jwt-admin';
export const INSTRUCTOR_AUTH = 'Bearer jwt-instructor';

class FakeJwtGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const role = /^Bearer jwt-(\w+)$/.exec(
      req.headers.authorization ?? '',
    )?.[1];
    if (!role) {
      throw new UnauthorizedException();
    }
    (req as Request & { user: unknown }).user = {
      sub: role === 'admin' ? ADMIN_ID : 'user-1',
      app_metadata: { role },
    };
    return true;
  }
}

export async function startAdminApp(
  builder: TestingModuleBuilder,
  configure?: (app: INestApplication<App>) => void,
): Promise<INestApplication<App>> {
  const moduleRef = await builder
    .overrideGuard(SupabaseAuthGuard)
    .useClass(FakeJwtGuard)
    .compile();
  const app = moduleRef.createNestApplication<INestApplication<App>>();
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  configure?.(app);
  await app.init();
  return app;
}
