-- CI-ONLY shim. NOT part of supabase/migrations (never applied to a real
-- Supabase project, which already provides all of this).
--
-- Plain Postgres has no `auth` schema, no Supabase roles, and no auth helper
-- functions, so `supabase/migrations/*.sql` cannot apply to a bare PG16
-- container. This file creates the minimum surface the migrations reference:
--
--   * roles    anon / authenticated / service_role
--   * schema   auth
--   * table    auth.users (id, email) — FK target for instructors.auth_user_id
--   * funcs    auth.uid(), auth.jwt(), auth.role()
--
-- Keep this in sync with whatever Supabase objects the migrations touch.

create extension if not exists pgcrypto;

-- ── Supabase roles (NOLOGIN; grants in 016 target these by name) ──
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end
$$;

create schema if not exists auth;
grant usage on schema auth to anon, authenticated, service_role;

-- ── auth.users: only the columns the migrations actually depend on ──
-- 001 references auth.users(id); 014 triggers on insert/update of email.
create table if not exists auth.users (
  id    uuid primary key default gen_random_uuid(),
  email text
);

-- ── auth helpers, reading the same GUC Supabase uses ──
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(
    current_setting('request.jwt.claims', true)::jsonb ->> 'sub',
    ''
  )::uuid;
$$;

create or replace function auth.jwt()
returns jsonb
language sql
stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb,
    '{}'::jsonb
  );
$$;

create or replace function auth.role()
returns text
language sql
stable
as $$
  select current_setting('request.jwt.claims', true)::jsonb ->> 'role';
$$;
