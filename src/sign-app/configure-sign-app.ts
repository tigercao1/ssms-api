import { type INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import { buildSigningCorsOptions, parseAllowedOrigins } from '../config/cors';
import { signingBodyParser } from '../documents/signing-body-parser';

export function configureSignApp(app: INestApplication): void {
  app.use(signingBodyParser);
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  const origins = parseAllowedOrigins(process.env.CORS_ALLOWED_ORIGINS);
  if (origins.length > 0) {
    app.enableCors(buildSigningCorsOptions(origins));
    Logger.log(`CORS enabled for: ${origins.join(', ')}`, 'Bootstrap');
  } else {
    Logger.log('CORS disabled (no CORS_ALLOWED_ORIGINS set)', 'Bootstrap');
  }
}
