#!/usr/bin/env ts-node
/**
 * T6.2 — First-admin bootstrap (ADMIN_ROLE_PLAN.md § First Admin Bootstrap).
 *
 * One-time, env-driven, idempotent. Run during initial deployment to create or
 * promote the very first admin. After this, additional admins are promoted via
 * `PATCH /admin/users/:id/role` by an existing admin.
 *
 * What it does (using the Supabase Admin API + secret key, which bypasses RLS):
 *   1. Look up the user by `BOOTSTRAP_ADMIN_EMAIL`.
 *   2. Create the `auth.users` row if missing (optional password), else reuse it.
 *   3. Set `app_metadata.role = 'admin'` (server-set only — instructors cannot
 *      self-promote).
 *   4. Mark the email as verified.
 *   5. Append a `system.bootstrap_admin` row to `audit_log` — but only when a
 *      change was actually made, so re-running is a true no-op.
 *
 * Idempotency: re-running with the same email neither duplicates the user nor
 * errors; if the user is already a verified admin it exits early.
 *
 * Usage (env must be exported, e.g. via your deploy secrets):
 *   export SUPABASE_URL=...                     # project URL
 *   export SUPABASE_SECRET_KEY=sb_secret_...    # server-only secret key
 *   export BOOTSTRAP_ADMIN_EMAIL=admin@school.example
 *   export BOOTSTRAP_ADMIN_PASSWORD=...         # optional; set for new users
 *   npx ts-node scripts/bootstrap-admin.ts
 */
import {
  createClient,
  type SupabaseClient,
  type User,
} from '@supabase/supabase-js';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

/** Paginate the Admin API to find a user by email (case-insensitive). */
async function findUserByEmail(
  supabase: SupabaseClient,
  email: string,
): Promise<User | null> {
  const target = email.trim().toLowerCase();
  const perPage = 1000;
  for (let page = 1; ; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({
      page,
      perPage,
    });
    if (error) {
      throw new Error(`Failed to list users: ${error.message}`);
    }
    const match = data.users.find(
      (u) => (u.email ?? '').toLowerCase() === target,
    );
    if (match) {
      return match;
    }
    if (data.users.length < perPage) {
      return null;
    }
  }
}

async function writeBootstrapAudit(
  supabase: SupabaseClient,
  userId: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  const { error } = await supabase.from('audit_log').insert({
    actor_user_id: null,
    actor_role: 'system',
    action: 'system.bootstrap_admin',
    target_type: 'user',
    target_id: userId,
    metadata,
  });
  if (error) {
    throw new Error(`Failed to write audit_log: ${error.message}`);
  }
}

async function main(): Promise<void> {
  const url = requireEnv('SUPABASE_URL');
  const secretKey = requireEnv('SUPABASE_SECRET_KEY');
  const email = requireEnv('BOOTSTRAP_ADMIN_EMAIL');
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;

  const supabase = createClient(url, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const existing = await findUserByEmail(supabase, email);

  if (!existing) {
    // Create a brand-new, email-verified admin.
    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password: password || undefined,
      email_confirm: true,
      app_metadata: { role: 'admin' },
    });
    if (error || !data.user) {
      throw new Error(
        `Failed to create admin user: ${error?.message ?? 'unknown error'}`,
      );
    }
    await writeBootstrapAudit(supabase, data.user.id, {
      email,
      outcome: 'created',
    });
    console.log(`✅ Created admin user ${email} (${data.user.id})`);
    return;
  }

  const alreadyAdmin =
    (existing.app_metadata as { role?: string } | undefined)?.role === 'admin';
  const alreadyVerified = Boolean(existing.email_confirmed_at);

  if (alreadyAdmin && alreadyVerified) {
    console.log(
      `ℹ️  ${email} (${existing.id}) is already a verified admin — no changes.`,
    );
    return;
  }

  // Promote the existing user and ensure their email is verified.
  const { data, error } = await supabase.auth.admin.updateUserById(
    existing.id,
    {
      email_confirm: true,
      app_metadata: {
        ...(existing.app_metadata ?? {}),
        role: 'admin',
      },
    },
  );
  if (error || !data.user) {
    throw new Error(
      `Failed to promote admin user: ${error?.message ?? 'unknown error'}`,
    );
  }
  await writeBootstrapAudit(supabase, existing.id, {
    email,
    outcome: 'promoted',
    previousRole:
      (existing.app_metadata as { role?: string } | undefined)?.role ?? null,
  });
  console.log(`✅ Promoted ${email} (${existing.id}) to admin.`);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`bootstrap-admin failed: ${message}`);
  process.exit(1);
});
