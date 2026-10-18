create table if not exists activation_resend_cooldowns (
  email_hash         text primary key
                       constraint activation_resend_cooldowns_email_hash_check
                       check (email_hash ~ '^[0-9a-f]{64}$'),
  last_requested_at  timestamptz not null default now()
);

alter table activation_resend_cooldowns enable row level security;
alter table activation_resend_cooldowns force row level security;
revoke all on activation_resend_cooldowns from public, anon, authenticated;

create or replace function public.claim_activation_resend(
  p_email_hash text,
  p_cooldown_seconds int
) returns table (accepted boolean, retry_after_seconds int)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_last timestamptz;
begin
  insert into activation_resend_cooldowns as c (email_hash, last_requested_at)
  values (p_email_hash, now())
  on conflict (email_hash) do update
     set last_requested_at = excluded.last_requested_at
   where c.last_requested_at <= now() - make_interval(secs => p_cooldown_seconds);

  if found then
    return query select true, p_cooldown_seconds;
    return;
  end if;

  select c.last_requested_at into v_last
    from activation_resend_cooldowns c
   where c.email_hash = p_email_hash;

  return query select
    false,
    greatest(
      1,
      ceil(extract(epoch from
        v_last + make_interval(secs => p_cooldown_seconds) - now()))::int
    );
end;
$$;

revoke all on function public.claim_activation_resend(text, int)
  from public, anon, authenticated;
grant execute on function public.claim_activation_resend(text, int)
  to service_role;

create or replace function public.activation_resend_retry_after(
  p_email_hash text,
  p_cooldown_seconds int
) returns int
language sql
stable
security invoker
set search_path = public
as $$
  select coalesce(
    (select greatest(
       0,
       ceil(extract(epoch from
         c.last_requested_at + make_interval(secs => p_cooldown_seconds) - now()))::int
     )
       from activation_resend_cooldowns c
      where c.email_hash = p_email_hash),
    0
  );
$$;

revoke all on function public.activation_resend_retry_after(text, int)
  from public, anon, authenticated;
grant execute on function public.activation_resend_retry_after(text, int)
  to service_role;
