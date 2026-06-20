import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * DI token for the server-side Supabase client.
 *
 * Services MUST inject this token instead of importing `createClient`
 * directly — this keeps the secret API key out of feature code and lets
 * tests bind a fake (see TESTING_STRATEGY.md § Mocking pattern — Supabase).
 */
export const SUPABASE_CLIENT = Symbol('SUPABASE_CLIENT');

export type SupabaseClientType = SupabaseClient;
