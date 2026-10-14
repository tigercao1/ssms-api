\set ON_ERROR_STOP on
begin;

insert into customers (id, shopify_customer_id, first_name, last_name, shopify_updated_at, created_at)
values ('77777777-7777-4777-8777-777777777701', 3001, 'Ann', 'Old', '2026-10-13 12:00Z', '2026-10-01Z'),
       ('77777777-7777-4777-8777-777777777702', 3002, 'Bo', 'Gone', '2026-10-01 12:00Z', '2026-10-01Z'),
       ('77777777-7777-4777-8777-777777777703', 3003, 'Cy', 'Back', '2026-10-01 12:00Z', '2026-10-01Z'),
       ('77777777-7777-4777-8777-777777777704', 3004, 'Di', 'New', '2026-10-01 12:00Z', '2026-10-20Z');
update customers set shopify_deleted_at = '2026-10-05Z' where shopify_customer_id = 3003;

do $$
begin
  if upsert_customer_if_newer(3001, 'Ann', 'Stale', null, null, '2026-10-13 11:00Z') <> 'stale' then
    raise exception 'an older update was not reported stale';
  end if;
  if upsert_customer_if_newer(3001, 'Ann', 'Same', null, null, '2026-10-13 12:00Z') <> 'stale' then
    raise exception 'an update with the same updated_at was applied';
  end if;
  if (select last_name from customers where shopify_customer_id = 3001) <> 'Old' then
    raise exception 'a stale update overwrote the row';
  end if;
  if upsert_customer_if_newer(3001, 'Ann', 'Newer', 'ann@example.com', '+1', '2026-10-13 13:00Z') <> 'updated' then
    raise exception 'a newer update was not applied';
  end if;
  if (select last_name || email || phone from customers where shopify_customer_id = 3001) <> 'Newerann@example.com+1' then
    raise exception 'a newer update did not write its fields';
  end if;
  if upsert_customer_if_newer(3999, 'Ed', null, null, null, '2026-10-13 13:00Z') <> 'inserted' then
    raise exception 'an unknown customer was not inserted';
  end if;
  begin
    perform upsert_customer_if_newer(3998, 'Fay', null, null, null, null);
    raise exception 'an upsert without updated_at was accepted';
  exception when null_value_not_allowed then null;
  end;
end
$$;

do $$
begin
  if mark_customer_deleted_in_shopify(3001, '2026-10-13 12:30Z') then
    raise exception 'a delete triggered before the stored update was applied';
  end if;
  if not mark_customer_deleted_in_shopify(3001, '2026-10-13 14:00Z') then
    raise exception 'a delete was not applied';
  end if;
  if mark_customer_deleted_in_shopify(3001, '2026-10-13 15:00Z') then
    raise exception 'a repeated delete changed the row';
  end if;
  if mark_customer_deleted_in_shopify(4242, '2026-10-13 15:00Z') then
    raise exception 'a delete for an unknown customer reported a change';
  end if;
  if (select count(*) from customers where shopify_customer_id = 3001) <> 1 then
    raise exception 'a delete removed the row';
  end if;
  perform upsert_customer_if_newer(3001, 'Ann', 'Between', null, null, '2026-10-13 13:30Z');
  if (select shopify_deleted_at from customers where shopify_customer_id = 3001) is null then
    raise exception 'an update older than the delete restored the customer';
  end if;
  perform upsert_customer_if_newer(3001, 'Ann', 'Restored', null, null, '2026-10-13 14:30Z');
  if (select shopify_deleted_at is not null or last_name <> 'Restored' from customers where shopify_customer_id = 3001) then
    raise exception 'an update newer than the delete did not restore the customer';
  end if;
end
$$;

do $$
declare
  v_counts jsonb;
begin
  v_counts := reconcile_customer_deletions(array[3001, 3003, 3999]::bigint[], '2026-10-14Z');
  if v_counts <> '{"deleted": 1, "restored": 1}'::jsonb then
    raise exception 'reconcile counted %', v_counts;
  end if;
  if (select shopify_deleted_at from customers where shopify_customer_id = 3002) is null then
    raise exception 'reconcile did not soft-delete a customer missing from Shopify';
  end if;
  if (select shopify_deleted_at from customers where shopify_customer_id = 3003) is not null then
    raise exception 'reconcile did not restore a customer listed by Shopify';
  end if;
  if (select shopify_deleted_at from customers where shopify_customer_id = 3004) is not null then
    raise exception 'reconcile deleted a customer created after it started';
  end if;
  if (select count(*) from customers where shopify_customer_id between 3001 and 3999) <> 5 then
    raise exception 'reconcile removed rows';
  end if;
end
$$;

do $$
begin
  insert into shopify_webhook_events (webhook_id, topic, shopify_customer_id)
  values ('wh-ci-1', 'customers/update', 3001);
  begin
    insert into shopify_webhook_events (webhook_id, topic) values ('wh-ci-1', 'customers/delete');
    raise exception 'a duplicate webhook id was accepted';
  exception when unique_violation then null;
  end;
  insert into shopify_webhook_events (webhook_id, topic) values ('wh-ci-1', 'customers/delete')
  on conflict (webhook_id) do nothing;
  if (select count(*) from shopify_webhook_events where webhook_id = 'wh-ci-1') <> 1 then
    raise exception 'webhook ids are not unique';
  end if;
  begin
    insert into shopify_webhook_events (webhook_id, topic, error)
    values ('wh-ci-2', 'customers/update', repeat('x', 2001));
    raise exception 'an oversized webhook error was accepted';
  exception when check_violation then null;
  end;
  update customer_sync_status
     set incremental_since = '2026-10-13 11:58Z',
         last_reconcile_at = now(),
         last_reconcile_error = 'Shopify listed 1 customers';
  begin
    update customer_sync_status set last_reconcile_error = repeat('x', 2001);
    raise exception 'an oversized reconcile error was accepted';
  exception when check_violation then null;
  end;
end
$$;

do $$
declare
  f text;
  r text;
begin
  if not exists (
    select 1 from pg_class
     where oid = 'public.shopify_webhook_events'::regclass and relrowsecurity and relforcerowsecurity
  ) then
    raise exception 'shopify_webhook_events does not have forced row level security';
  end if;
  foreach r in array array['anon', 'authenticated'] loop
    if has_table_privilege(r, 'public.shopify_webhook_events', 'select, insert, update, delete') then
      raise exception '% has privileges on shopify_webhook_events', r;
    end if;
  end loop;
  foreach f in array array[
    'public.upsert_customer_if_newer(bigint, text, text, text, text, timestamptz)',
    'public.mark_customer_deleted_in_shopify(bigint, timestamptz)',
    'public.reconcile_customer_deletions(bigint[], timestamptz)'
  ] loop
    foreach r in array array['anon', 'authenticated'] loop
      if has_function_privilege(r, f, 'execute') then
        raise exception '% can execute %', r, f;
      end if;
    end loop;
    if exists (
      select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
       where p.oid = f::regprocedure and a.grantee = 0
    ) then
      raise exception 'PUBLIC can execute %', f;
    end if;
    if not has_function_privilege('service_role', f, 'execute') then
      raise exception 'service_role cannot execute %', f;
    end if;
  end loop;
end
$$;

set local role anon;
do $$
begin
  perform 1 from shopify_webhook_events;
  raise exception 'anon could read shopify_webhook_events';
exception when insufficient_privilege then null;
end
$$;
reset role;

rollback;
\echo 'Customer webhook checks passed.'
