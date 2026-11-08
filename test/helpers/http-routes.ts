import type { INestApplication } from '@nestjs/common';

interface RouterLayer {
  route?: { path: string; methods: Record<string, boolean> };
}

export function listRoutes(app: INestApplication): string[] {
  const express = app.getHttpAdapter().getInstance() as {
    router: { stack: RouterLayer[] };
  };
  return express.router.stack
    .flatMap(({ route }) =>
      route
        ? Object.keys(route.methods).map(
            (method) => `${method.toUpperCase()} ${route.path}`,
          )
        : [],
    )
    .sort();
}
