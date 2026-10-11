create table instructor_invites (
  id             uuid primary key default gen_random_uuid(),
  instructor_id  uuid not null references instructors (id) on delete cascade,
  auth_user_id   uuid not null references auth.users (id) on delete cascade,
  email          text not null
                   constraint instructor_invites_email_lowercase
                   check (email = lower(email)),
  token_hash     text unique
                   constraint instructor_invites_token_hash_sha256
                   check (token_hash ~ '^[0-9a-f]{64}$'),
  season         text not null,
  expires_at     timestamptz,
  sent_at        timestamptz,
  reminded_at    timestamptz,
  redeemed_at    timestamptz,
  activated_at   timestamptz,
  created_at     timestamptz not null default now(),
  constraint instructor_invites_token_has_expiry
    check (token_hash is null or expires_at is not null),
  constraint instructor_invites_instructor_season_key
    unique (instructor_id, season)
);

create index instructor_invites_email_idx
  on instructor_invites (email);

create index instructor_invites_auth_user_id_idx
  on instructor_invites (auth_user_id);

alter table instructor_invites enable row level security;
alter table instructor_invites force row level security;
revoke all on instructor_invites from public, anon, authenticated;

comment on table instructor_invites is
  'Season invite per instructor: sha256 hash of the activation token only, never the token. Written by the API and the roster import script, service_role only.';
