-- T2.10 audit_log. Append-only, security-relevant actions only.
-- Schema is LOCKED in RLS_AND_SECURITY_PLAN.md § Audit Log.

create table audit_log (
  id             uuid primary key default gen_random_uuid(),
  actor_user_id  uuid,                     -- null for system / bootstrap
  actor_role     text,                     -- 'admin' | 'instructor' | 'system'
  action         text not null,            -- e.g. 'instructor.approve'
  target_type    text,                     -- 'instructor' | 'user' | 'api_key'
  target_id      uuid,
  metadata       jsonb,                    -- before/after, reason, etc.
  ip             inet,
  user_agent     text,
  inserted_at    timestamptz not null default now()
);

create index audit_log_target_id_idx on audit_log (target_id);
create index audit_log_action_idx on audit_log (action);
create index audit_log_inserted_at_idx on audit_log (inserted_at);

-- Append-only is enforced in 017 (RLS) + grants: no UPDATE/DELETE for any
-- non-superuser role. service_role inserts (bypasses RLS).
