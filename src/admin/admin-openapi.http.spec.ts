import type { INestApplication } from '@nestjs/common';
import type { OpenAPIObject } from '@nestjs/swagger';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import {
  ADMIN_AUTH,
  INSTRUCTOR_AUTH,
  startAdminApp,
} from '../../test/helpers/admin-http';
import { makeFakeSupabase } from '../../test/helpers/make-fake-supabase';
import { AppModule } from '../app.module';
import { SUPABASE_CLIENT } from '../database/supabase-client.token';
import { AdminOpenApiService } from './admin-openapi.service';

type Operation = {
  description?: string;
  'x-session-only'?: boolean;
  requestBody?: {
    content: { 'application/json': { schema: { $ref: string } } };
  };
};

describe('GET /admin/openapi.json', () => {
  let app: INestApplication<App>;
  let spec: OpenAPIObject;

  beforeAll(async () => {
    app = await startAdminApp(
      Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(SUPABASE_CLIENT)
        .useValue(makeFakeSupabase().client),
    );
    const res = await request(app.getHttpServer())
      .get('/admin/openapi.json')
      .set('Authorization', ADMIN_AUTH)
      .expect(200);
    spec = res.body as OpenAPIObject;
  });

  afterAll(async () => {
    await app.close();
  });

  function operation(path: string, method: string): Operation | undefined {
    return (spec.paths[path] as Record<string, Operation> | undefined)?.[
      method
    ];
  }

  function bodySchema(path: string, method: string) {
    const ref = operation(path, method)?.requestBody?.content[
      'application/json'
    ].schema.$ref;
    return spec.components?.schemas?.[ref?.split('/').pop() ?? ''];
  }

  it('describes admin routes from every admin controller with their methods', () => {
    expect(spec.openapi).toMatch(/^3\./);
    expect(Object.keys(spec.paths['/admin/instructors'] ?? {})).toEqual([
      'get',
    ]);
    expect(
      operation('/admin/instructors/{id}/approval', 'patch'),
    ).toBeDefined();
    expect(operation('/admin/users/{id}/role', 'patch')).toBeDefined();
    expect(operation('/admin/documents/templates', 'post')).toBeDefined();
    expect(
      operation(
        '/admin/insurance/instructors/{instructorId}/season-pass',
        'post',
      ),
    ).toBeDefined();
    expect(
      operation('/admin/documents/forms/{id}/versions/{lang}', 'put'),
    ).toBeDefined();
    expect(operation('/admin/signatures', 'get')).toBeDefined();
    expect(operation('/admin/openapi.json', 'get')).toBeDefined();
  });

  it('leaves out routes that are not admin-only', () => {
    const paths = Object.keys(spec.paths);
    expect(paths.every((path) => path.startsWith('/admin/'))).toBe(true);
    expect(paths).not.toContain('/me/instructor');
    expect(paths).not.toContain('/admin/google/oauth/callback');
    expect(paths.some((path) => path.startsWith('/sign/'))).toBe(false);
  });

  it('flags the session-only routes that refuse API tokens', () => {
    const sessionOnly = Object.entries(spec.paths).flatMap(([path, item]) =>
      Object.entries(item as Record<string, Operation>)
        .filter(([, op]) => op['x-session-only'] === true)
        .map(([method]) => `${method.toUpperCase()} ${path}`),
    );
    expect(sessionOnly.sort()).toEqual([
      'DELETE /admin/api-tokens/{id}',
      'GET /admin/api-tokens',
      'GET /admin/google/connect',
      'PATCH /admin/instructors/{id}/email',
      'PATCH /admin/users/{id}/role',
      'POST /admin/api-tokens',
      'POST /admin/api-tokens/{id}/rotate',
    ]);
    expect(operation('/admin/users/{id}/role', 'patch')?.description).toMatch(
      /API tokens get 403/,
    );
    const approval = operation('/admin/instructors/{id}/approval', 'patch');
    expect(approval?.['x-session-only']).toBeUndefined();
    expect(approval?.description ?? '').not.toMatch(/Session only/);
  });

  it('includes request body schemas inferred from the DTOs', () => {
    expect(bodySchema('/admin/users/{id}/role', 'patch')).toMatchObject({
      required: ['role'],
      properties: { role: { enum: ['admin', 'instructor'] } },
    });
    expect(
      bodySchema('/admin/instructors/{id}/approval', 'patch'),
    ).toMatchObject({
      required: ['approvalStatus'],
      properties: {
        approvalStatus: { enum: ['approved', 'rejected'] },
        reason: { type: 'string', maxLength: 500 },
      },
    });
    expect(bodySchema('/admin/documents/forms', 'post')).toMatchObject({
      required: ['slug', 'titleEn'],
      properties: { slug: { maxLength: 60 }, titleEn: { type: 'string' } },
    });
  });

  it('declares the Bearer security scheme for every operation', () => {
    expect(spec.components?.securitySchemes?.bearer).toMatchObject({
      type: 'http',
      scheme: 'bearer',
    });
    expect(spec.security).toEqual([{ bearer: [] }]);
  });

  it('builds the document once and serves it from cache', async () => {
    const service = app.get(AdminOpenApiService);
    expect(service.getDocument()).toBe(service.getDocument());
    const again = await request(app.getHttpServer())
      .get('/admin/openapi.json')
      .set('Authorization', ADMIN_AUTH)
      .expect(200);
    expect(again.body).toEqual(spec);
  });

  it('rejects non-admins with 403', async () => {
    await request(app.getHttpServer())
      .get('/admin/openapi.json')
      .set('Authorization', INSTRUCTOR_AUTH)
      .expect(403);
  });

  it('rejects anonymous callers with 401', async () => {
    await request(app.getHttpServer()).get('/admin/openapi.json').expect(401);
  });
});
