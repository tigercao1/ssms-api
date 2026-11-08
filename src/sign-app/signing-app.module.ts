import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { envFilePaths } from '../config/env-files';
import { DatabaseModule } from '../database/database.module';
import { FormSigningModule } from '../documents/form-signing.module';
import { HealthModule } from '../health/health.module';
import { validateSignEnv } from './sign-env.validation';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateSignEnv,
      envFilePath: envFilePaths(),
    }),
    DatabaseModule,
    HealthModule,
    FormSigningModule,
  ],
})
export class SigningAppModule {}
