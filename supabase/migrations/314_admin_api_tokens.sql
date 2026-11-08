create table admin_api_tokens (
  id             uuid primary key default gen_random_uuid(),
  owner_user_id  uuid not null references auth.users (id) on delete cascade,
  name           text not null
                   constraint admin_api_tokens_name_check
                   check (char_length(btrim(name)) between 1 and 100),
  token_hash     text not null unique
                   constraint admin_api_tokens_token_hash_check
                   check (token_hash ~ '^[0-9a-f]{64}$'),
  token_prefix   text not null
                   constraint admin_api_tokens_token_prefix_check
                   check (token_prefix ~ '^ssms_pat_[A-Za-z0-9_-]{4}$'),
  token_last4    text not null
                   constraint admin_api_tokens_token_last4_check
                   check (token_last4 ~ '^[A-Za-z0-9_-]{4}$'),
  created_at     timestamptz not null default now(),
  expires_at     timestamptz,
  last_used_at   timestamptz,
  revoked_at     timestamptz,
  replaced_by    uuid references admin_api_tokens (id),
  grace_until    timestamptz,
  constraint admin_api_tokens_rotation_check
    check ((replaced_by is null) = (grace_until is null))
);

create index admin_api_tokens_owner_idx
  on admin_api_tokens (owner_user_id, created_at desc);

alter table admin_api_tokens enable row level security;
alter table admin_api_tokens force row level security;
revoke all on admin_api_tokens from public, anon, authenticated;

create or replace function public.rotate_admin_api_token(
  p_token_id uuid,
  p_owner_user_id uuid,
  p_token_hash text,
  p_token_prefix text,
  p_token_last4 text,
  p_keep_expiry boolean,
  p_expires_at timestamptz,
  p_grace_minutes int
) returns table (
  id uuid,
  owner_user_id uuid,
  name text,
  token_prefix text,
  token_last4 text,
  created_at timestamptz,
  expires_at timestamptz,
  last_used_at timestamptz,
  revoked_at timestamptz,
  replaced_by uuid,
  grace_until timestamptz
)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_old admin_api_tokens;
  v_new admin_api_tokens;
begin
  if p_grace_minutes is null or p_grace_minutes < 0 or p_grace_minutes > 1440 then
    raise exception 'grace minutes must be between 0 and 1440'
      using errcode = '22023';
  end if;

  select * into v_old
    from admin_api_tokens t
   where t.id = p_token_id
     and t.owner_user_id = p_owner_user_id
     and t.revoked_at is null
     and t.replaced_by is null
     and (t.expires_at is null or t.expires_at > now())
   for update;

  if not found then
    return;
  end if;

  insert into admin_api_tokens (
    owner_user_id, name, token_hash, token_prefix, token_last4, expires_at
  ) values (
    v_old.owner_user_id,
    v_old.name,
    p_token_hash,
    p_token_prefix,
    p_token_last4,
    case
      when not p_keep_expiry then p_expires_at
      when v_old.expires_at is null then null
      else now() + (v_old.expires_at - v_old.created_at)
    end
  )
  returning * into v_new;

  update admin_api_tokens t
     set replaced_by = v_new.id,
         grace_until = now() + make_interval(mins => p_grace_minutes)
   where t.id = v_old.id;

  return query select
    v_new.id, v_new.owner_user_id, v_new.name, v_new.token_prefix,
    v_new.token_last4, v_new.created_at, v_new.expires_at,
    v_new.last_used_at, v_new.revoked_at, v_new.replaced_by,
    v_new.grace_until;
end;
$$;

revoke all on function public.rotate_admin_api_token(
  uuid, uuid, text, text, text, boolean, timestamptz, int
) from public, anon, authenticated;
grant execute on function public.rotate_admin_api_token(
  uuid, uuid, text, text, text, boolean, timestamptz, int
) to service_role;
