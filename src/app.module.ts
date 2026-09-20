import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { DatabaseModule } from './database/database.module';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { HealthModule } from './health/health.module';
import { validateEnv } from './config/env.validation';
import { ReferenceDataModule } from './reference-data/reference-data.module';
import { BioTranslationModule } from './bio-translation/bio-translation.module';
import { InstructorsModule } from './instructors/instructors.module';
import { MediaModule } from './media/media.module';
import { AdminModule } from './admin/admin.module';
import { PublicApiModule } from './public-api/public-api.module';
import { MailerModule } from './mailer/mailer.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv,
      // Environment selection is explicit: SSMS_ENV=dev|prod picks .env.<env>,
      // matching scripts/env.sh so the app and the ops scripts can never point
      // at different Supabase projects. Plain `.env` remains a fallback for
      // local one-offs; real deploys inject env vars directly (Fly secrets),
      // where no file exists and this list is simply ignored.
      envFilePath: [
        ...(process.env.SSMS_ENV ? [`.env.${process.env.SSMS_ENV}`] : []),
        '.env',
      ],
    }),
    DatabaseModule,
    AuditModule,
    AuthModule,
    HealthModule,
    ReferenceDataModule,
    BioTranslationModule,
    InstructorsModule,
    MediaModule,
    AdminModule,
    PublicApiModule,
    MailerModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
