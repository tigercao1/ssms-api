import { NestFactory } from '@nestjs/core';
import { configureSignApp } from './sign-app/configure-sign-app';
import { SigningAppModule } from './sign-app/signing-app.module';

async function bootstrap() {
  const app = await NestFactory.create(SigningAppModule);
  configureSignApp(app);
  await app.listen(process.env.PORT ?? 3000, '0.0.0.0');
}
void bootstrap();
