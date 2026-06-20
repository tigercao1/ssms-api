import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from './supabase-client.token';

/**
 * Provides the server-side Supabase client built with the SECRET API key
 * (`sb_secret_...`, the successor to the legacy service_role key).
 *
 * The secret key bypasses RLS by design (see RLS_AND_SECURITY_PLAN.md) and must
 * NEVER reach the frontend. All server reads/writes go through this client.
 * Global so feature modules can inject SUPABASE_CLIENT without re-importing.
 */
@Global()
@Module({
  providers: [
    {
      provide: SUPABASE_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const url = config.getOrThrow<string>('SUPABASE_URL');
        const secretKey = config.getOrThrow<string>('SUPABASE_SECRET_KEY');
        return createClient(url, secretKey, {
          auth: { persistSession: false, autoRefreshToken: false },
        });
      },
    },
  ],
  exports: [SUPABASE_CLIENT],
})
export class DatabaseModule {}
