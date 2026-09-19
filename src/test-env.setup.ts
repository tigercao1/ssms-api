/**
 * Jest setupFiles hook — runs BEFORE any test module is imported.
 *
 * `AppModule` calls `ConfigModule.forRoot({ validate: validateEnv })` at module
 * *decoration* time, i.e. as soon as the file is imported. Setting env vars
 * inside a test body is therefore too late (the import at the top of the spec
 * has already thrown). Locally this was masked by the gitignored `.env` that
 * ConfigModule auto-loads; CI has no `.env`, so the bootstrap spec failed there
 * only.
 *
 * These are inert placeholders — the Supabase client is always overridden with
 * a fake in tests, so no network call or real secret is involved.
 */
process.env.SUPABASE_URL ??= 'http://localhost';
process.env.SUPABASE_SECRET_KEY ??= 'test-secret-key';
process.env.SUPABASE_STORAGE_BUCKET ??= 'instructor-public';
