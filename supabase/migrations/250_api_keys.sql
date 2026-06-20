-- T7.8 — Public API keys (hashed at rest). See PUBLIC_API_PLAN.md § Auth Model
-- and RLS_AND_SECURITY_PLAN.md § api_keys.
--
-- One key per consumer (e.g. 'shopify-storefront', 'wechat-app'). The full
-- secret (`ssms_live_<random>` / `ssms_test_<random>`) is shown ONCE on
-- creation and never stored — only its SHA-256 hash lives here. Auth hashes the
-- presented bearer token and looks it up by `key_hash` (see ApiKeyGuard / T7.7).
--
-- Revocation is a soft delete (`revoked_at`): the row is kept for audit, but the
-- partial unique index below stops it from authenticating. Rotation = issue a
-- new key alongside, then revoke the old one.

create table api_keys (
  id                  uuid primary key default gen_random_uuid(),

  -- Human label for the consumer this key belongs to.
  name                text not null,

  -- 'live' (prod) or 'test' (everything else). Drives the key prefix.
  environment         text not null default 'live'
                        check (environment in ('live', 'test')),

  -- Visible, non-secret prefix stored for display/debugging, e.g. 'ssms_live'.
  prefix              text not null,

  -- Last 4 chars of the secret part — lets an operator identify a key in a list
  -- without ever exposing the secret.
  last_four           text not null,

  -- SHA-256 (hex) of the full presented key. The plaintext is never stored.
  key_hash            text not null,

  -- Per-key rate limit (requests/minute). Default 60 (RLS_AND_SECURITY_PLAN.md
  -- § Rate limiting). Bump for a consumer that legitimately needs more.
  rate_limit_per_min  integer not null default 60
                        check (rate_limit_per_min > 0),

  created_at          timestamptz not null default now(),
  created_by          uuid,            -- admin/user that issued it (nullable: bootstrap/system)

  revoked_at          timestamptz,     -- null = active
  revoked_by          uuid
);

-- Active keys must hash-collide-free; a revoked key's hash may be reissued in
-- theory but practically never is. Partial unique on active rows keeps lookups
-- (`where key_hash = $1 and revoked_at is null`) index-served and unambiguous.
create unique index api_keys_active_hash_uniq
  on api_keys (key_hash)
  where revoked_at is null;

create index api_keys_created_at_idx on api_keys (created_at);

-- Secrets table: NestJS-only via the service-role key (BYPASSRLS). No
-- anon/authenticated access whatsoever; RLS enabled + forced with no policies so
-- a future accidental grant still cannot read key hashes.
alter table api_keys enable row level security;
alter table api_keys force row level security;
revoke all on api_keys from anon, authenticated;

-- Safe projection for any future admin "list keys" surface: never exposes
-- key_hash. Not granted to anon/authenticated (service-role path only).
create view v_api_keys_public as
  select
    id,
    name,
    environment,
    prefix,
    last_four,
    rate_limit_per_min,
    created_at,
    revoked_at
  from api_keys;

revoke all on v_api_keys_public from anon, authenticated;

comment on table api_keys is
  'Public-API consumer keys (T7.8). Hashed at rest; service_role only.';
comment on column api_keys.key_hash is
  'SHA-256 hex of the full key. Plaintext is shown once on creation, never stored.';
comment on column api_keys.revoked_at is
  'Soft-delete: non-null disables auth via the partial unique index.';
