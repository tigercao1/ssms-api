create table if not exists google_connection (
  id                 boolean primary key default true check (id),
  account_email      text not null,
  refresh_token_enc  text,
  scopes             text[] not null default '{}',
  connected_at       timestamptz not null default now(),
  connected_by       uuid,
  last_refresh_at    timestamptz,
  last_error         text,
  last_error_at      timestamptz
);

alter table google_connection enable row level security;
alter table google_connection force row level security;
revoke all on google_connection from public, anon, authenticated;
