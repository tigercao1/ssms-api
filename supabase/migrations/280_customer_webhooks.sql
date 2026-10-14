alter table customers add column if not exists shopify_deleted_at timestamptz;

create index if not exists customers_shopify_deleted_at_idx
  on customers (shopify_deleted_at)
  where shopify_deleted_at is not null;

alter table customer_sync_status
  add column if not exists incremental_since timestamptz,
  add column if not exists last_reconcile_at timestamptz,
  add column if not exists last_reconcile_error text
    constraint customer_sync_status_last_reconcile_error_check
    check (char_length(last_reconcile_error) <= 2000);

create table if not exists shopify_webhook_events (
  id                   uuid primary key default gen_random_uuid(),
  webhook_id           text not null
                         constraint shopify_webhook_events_webhook_id_key unique,
  topic                text not null,
  shopify_customer_id  bigint,
  triggered_at         timestamptz,
  received_at          timestamptz not null default now(),
  processed_at         timestamptz,
  error                text
                         constraint shopify_webhook_events_error_check
                         check (char_length(error) <= 2000)
);

create index if not exists shopify_webhook_events_received_at_idx
  on shopify_webhook_events (received_at);

alter table shopify_webhook_events enable row level security;
alter table shopify_webhook_events force row level security;
revoke all on shopify_webhook_events from public, anon, authenticated;

create or replace function public.upsert_customer_if_newer(
  p_shopify_customer_id bigint,
  p_first_name text,
  p_last_name text,
  p_email text,
  p_phone text,
  p_shopify_updated_at timestamptz
) returns text
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_inserted boolean;
begin
  if p_shopify_updated_at is null then
    raise exception 'upsert_customer_if_newer needs p_shopify_updated_at'
      using errcode = '22004';
  end if;

  insert into customers as c (
    shopify_customer_id, first_name, last_name, email, phone, shopify_updated_at
  ) values (
    p_shopify_customer_id, p_first_name, p_last_name, p_email, p_phone, p_shopify_updated_at
  )
  on conflict (shopify_customer_id) do update
     set first_name = excluded.first_name,
         last_name = excluded.last_name,
         email = excluded.email,
         phone = excluded.phone,
         shopify_updated_at = excluded.shopify_updated_at,
         shopify_deleted_at = case
           when c.shopify_deleted_at < excluded.shopify_updated_at then null
           else c.shopify_deleted_at
         end
   where c.shopify_updated_at is null
      or c.shopify_updated_at < excluded.shopify_updated_at
  returning (xmax = 0) into v_inserted;

  if not found then
    return 'stale';
  end if;
  return case when v_inserted then 'inserted' else 'updated' end;
end;
$$;

revoke all on function public.upsert_customer_if_newer(bigint, text, text, text, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.upsert_customer_if_newer(bigint, text, text, text, text, timestamptz)
  to service_role;

create or replace function public.mark_customer_deleted_in_shopify(
  p_shopify_customer_id bigint,
  p_deleted_at timestamptz
) returns boolean
language plpgsql
security invoker
set search_path = public
as $$
begin
  update customers
     set shopify_deleted_at = p_deleted_at
   where shopify_customer_id = p_shopify_customer_id
     and shopify_deleted_at is null
     and (shopify_updated_at is null or shopify_updated_at <= p_deleted_at);
  return found;
end;
$$;

revoke all on function public.mark_customer_deleted_in_shopify(bigint, timestamptz)
  from public, anon, authenticated;
grant execute on function public.mark_customer_deleted_in_shopify(bigint, timestamptz)
  to service_role;

create or replace function public.reconcile_customer_deletions(
  p_shopify_ids bigint[],
  p_started_at timestamptz
) returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_deleted int;
  v_restored int;
begin
  update customers c
     set shopify_deleted_at = now()
   where c.shopify_deleted_at is null
     and c.created_at < p_started_at
     and not exists (
       select 1 from unnest(p_shopify_ids) s (id) where s.id = c.shopify_customer_id
     );
  get diagnostics v_deleted = row_count;

  update customers c
     set shopify_deleted_at = null
   where c.shopify_deleted_at < p_started_at
     and exists (
       select 1 from unnest(p_shopify_ids) s (id) where s.id = c.shopify_customer_id
     );
  get diagnostics v_restored = row_count;

  return jsonb_build_object('deleted', v_deleted, 'restored', v_restored);
end;
$$;

revoke all on function public.reconcile_customer_deletions(bigint[], timestamptz)
  from public, anon, authenticated;
grant execute on function public.reconcile_customer_deletions(bigint[], timestamptz)
  to service_role;
