import { type INestApplication, Injectable, type Type } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import {
  ApplicationConfig,
  HttpAdapterHost,
  ModulesContainer,
} from '@nestjs/core';
import type { Module } from '@nestjs/core/injector/module';
import {
  DocumentBuilder,
  type OpenAPIObject,
  SwaggerModule,
} from '@nestjs/swagger';
import loadOpenApiMetadata from './openapi-metadata';
import { RolesGuard } from './roles.guard';

const BEARER_SCHEME = 'bearer';

type AdminModuleView = 'controllers' | 'metatype' | 'imports';

function guardsOf(target: object): unknown[] {
  return (Reflect.getMetadata(GUARDS_METADATA, target) as unknown[]) ?? [];
}

function adminOperationIds(controller: Type): Set<string> {
  const prototype = controller.prototype as Record<string, unknown>;
  const adminController = guardsOf(controller).includes(RolesGuard);
  const methods = Object.getOwnPropertyNames(prototype).filter((name) => {
    const handler = prototype[name];
    return (
      name !== 'constructor' &&
      typeof handler === 'function' &&
      (adminController || guardsOf(handler).includes(RolesGuard))
    );
  });
  return new Set(methods.map((method) => `${controller.name}_${method}`));
}

@Injectable()
export class AdminOpenApiService {
  private document?: Promise<OpenAPIObject>;

  constructor(
    private readonly modules: ModulesContainer,
    private readonly adapterHost: HttpAdapterHost,
  ) {}

  getDocument(): Promise<OpenAPIObject> {
    this.document ??= this.build().catch((err: unknown) => {
      this.document = undefined;
      throw err;
    });
    return this.document;
  }

  private async build(): Promise<OpenAPIObject> {
    await SwaggerModule.loadPluginMetadata(loadOpenApiMetadata);
    const operationIds = new Set<string>();
    const adminModules = new Map<string, Pick<Module, AdminModuleView>>();
    for (const [key, module] of this.modules) {
      const controllers: Module['controllers'] = new Map();
      for (const [token, wrapper] of module.controllers) {
        const ids = adminOperationIds(wrapper.metatype as Type);
        ids.forEach((id) => operationIds.add(id));
        if (ids.size > 0) {
          controllers.set(token, wrapper);
        }
      }
      if (controllers.size > 0) {
        adminModules.set(key, {
          controllers,
          metatype: module.metatype,
          imports: module.imports,
        });
      }
    }
    const scanTarget = {
      container: {
        getModules: () =>
          Object.assign(adminModules, {
            applicationId: this.modules.applicationId,
          }),
      },
      config: new ApplicationConfig(),
      getHttpAdapter: () => this.adapterHost.httpAdapter,
    } as unknown as INestApplication;
    const config = new DocumentBuilder()
      .setTitle('SSMS admin API')
      .setVersion('1')
      .addBearerAuth(
        {
          type: 'http',
          scheme: 'bearer',
          description: 'Supabase session JWT or personal admin API token',
        },
        BEARER_SCHEME,
      )
      .addSecurityRequirements(BEARER_SCHEME)
      .build();
    const document = SwaggerModule.createDocument(scanTarget, config);
    for (const [path, item] of Object.entries(document.paths)) {
      for (const method of Object.keys(item) as (keyof typeof item)[]) {
        const operation = item[method] as { operationId?: string } | undefined;
        if (
          operation?.operationId &&
          !operationIds.has(operation.operationId)
        ) {
          delete item[method];
        }
      }
      if (Object.keys(item).length === 0) {
        delete document.paths[path];
      }
    }
    return document;
  }
}
