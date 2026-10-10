create table if not exists shopify_sync_settings (
  id               boolean primary key default true check (id),
  enabled          boolean not null default false,
  updated_at       timestamptz not null default now(),
  updated_by       uuid,
  last_tick_at     timestamptz,
  last_success_at  timestamptz,
  last_error       text,
  last_error_at    timestamptz
);

insert into shopify_sync_settings (id) values (true)
on conflict (id) do nothing;

alter table shopify_sync_settings enable row level security;
alter table shopify_sync_settings force row level security;
revoke all on shopify_sync_settings from anon, authenticated;

create or replace function public.enqueue_one_instructor_sync(
  p_instructor_id uuid
) returns void
language sql
security invoker
set search_path = public
as $$
  insert into instructor_sync_queue (instructor_id)
  values (p_instructor_id)
  on conflict (instructor_id) do update
    set enqueued_at = now(), attempts = 0;
$$;

revoke all on function public.enqueue_one_instructor_sync(uuid)
  from public, anon, authenticated;
grant execute on function public.enqueue_one_instructor_sync(uuid)
  to service_role;

create or replace function public.shopify_sync_stats(
  p_max_attempts int default 10
) returns table (
  pending             int,
  retrying            int,
  failed              int,
  oldest_enqueued_at  timestamptz,
  synced              int,
  active              int,
  draft               int
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    (select count(*)::int from instructor_sync_queue where attempts = 0),
    (select count(*)::int from instructor_sync_queue
      where attempts > 0 and attempts < p_max_attempts),
    (select count(*)::int from instructor_sync_queue
      where attempts >= p_max_attempts),
    (select min(enqueued_at) from instructor_sync_queue),
    (select count(*)::int from instructor_shopify_state
      where shopify_metaobject_id is not null),
    (select count(*)::int from instructor_shopify_state
      where shopify_metaobject_id is not null and last_status = 'active'),
    (select count(*)::int from instructor_shopify_state
      where shopify_metaobject_id is not null and last_status = 'draft');
$$;

revoke all on function public.shopify_sync_stats(int)
  from public, anon, authenticated;
grant execute on function public.shopify_sync_stats(int)
  to service_role;
