create table if not exists customer_sync_status (
  id                boolean primary key default true
                      constraint customer_sync_status_singleton check (id),
  lock_token        uuid,
  locked_until      timestamptz,
  last_started_at   timestamptz,
  last_finished_at  timestamptz,
  last_success_at   timestamptz,
  last_fetched      int
                      constraint customer_sync_status_last_fetched_check
                      check (last_fetched >= 0),
  last_error        text
                      constraint customer_sync_status_last_error_check
                      check (char_length(last_error) <= 2000),
  updated_at        timestamptz not null default now()
);

insert into customer_sync_status (id) values (true) on conflict (id) do nothing;

create or replace trigger customer_sync_status_set_updated_at
  before update on customer_sync_status
  for each row execute function public.set_updated_at();

alter table customer_sync_status enable row level security;
alter table customer_sync_status force row level security;
revoke all on customer_sync_status from public, anon, authenticated;

create or replace function public.try_lock_customer_sync(p_lease_seconds int)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_token uuid;
begin
  if not pg_try_advisory_xact_lock(hashtextextended('customer_sync', 0)) then
    return null;
  end if;

  insert into customer_sync_status (id) values (true) on conflict (id) do nothing;

  update customer_sync_status
     set lock_token = gen_random_uuid(),
         locked_until = now() + make_interval(secs => p_lease_seconds),
         last_started_at = now()
   where id
     and (locked_until is null or locked_until <= now())
  returning lock_token into v_token;

  return v_token;
end;
$$;

revoke all on function public.try_lock_customer_sync(int)
  from public, anon, authenticated;
grant execute on function public.try_lock_customer_sync(int)
  to service_role;

create or replace function public.finish_customer_sync(
  p_token uuid,
  p_fetched int,
  p_error text
) returns boolean
language plpgsql
security invoker
set search_path = public
as $$
begin
  update customer_sync_status
     set lock_token = null,
         locked_until = null,
         last_finished_at = now(),
         last_error = p_error,
         last_fetched = case when p_error is null then p_fetched else last_fetched end,
         last_success_at = case when p_error is null then now() else last_success_at end
   where id
     and lock_token = p_token;
  return found;
end;
$$;

revoke all on function public.finish_customer_sync(uuid, int, text)
  from public, anon, authenticated;
grant execute on function public.finish_customer_sync(uuid, int, text)
  to service_role;
