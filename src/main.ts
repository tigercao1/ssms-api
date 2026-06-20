import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { buildCorsOptions, parseAllowedOrigins } from './config/cors';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Global validation — see backend-architecture.md §4.
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // CORS for the portal — allow-list only; deny-all when unset (W0.5).
  const origins = parseAllowedOrigins(process.env.CORS_ALLOWED_ORIGINS);
  if (origins.length > 0) {
    app.enableCors(buildCorsOptions(origins));
    Logger.log(`CORS enabled for: ${origins.join(', ')}`, 'Bootstrap');
  } else {
    Logger.log('CORS disabled (no CORS_ALLOWED_ORIGINS set)', 'Bootstrap');
  }

  await app.listen(process.env.PORT ?? 3000);
}
void bootstrap();
