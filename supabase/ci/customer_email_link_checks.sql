\set ON_ERROR_STOP on
begin;

insert into customers (id, shopify_customer_id, first_name, last_name, email, shopify_deleted_at, created_at) values
  ('77777777-7777-4777-8777-777777777c01', null, 'Lin', 'Waiver', ' Lin@Example.com ', null, '2026-01-01Z'),
  ('77777777-7777-4777-8777-777777777c02', null, 'Lin', 'Later', 'lin@example.com', null, '2026-02-01Z'),
  ('77777777-7777-4777-8777-777777777c03', 6001, 'Ott', 'Shopify', 'ott@example.com', null, '2026-01-01Z'),
  ('77777777-7777-4777-8777-777777777c04', null, 'Del', 'Gone', 'del@example.com', '2026-03-01Z', '2026-01-01Z'),
  ('77777777-7777-4777-8777-777777777c05', null, 'No', 'Email', null, null, '2026-01-01Z'),
  ('77777777-7777-4777-8777-777777777c06', null, 'Blank', 'Email', '  ', null, '2026-01-01Z'),
  ('77777777-7777-4777-8777-777777777c07', null, 'Bulk', 'Waiver', 'BULK@example.com', null, '2026-01-01Z'),
  ('77777777-7777-4777-8777-777777777c08', 6008, 'Old', 'Name', 'known@example.com', null, '2026-01-01Z'),
  ('77777777-7777-4777-8777-777777777c09', null, 'Admin', 'Waiver', 'admin.made@example.com', null, '2026-01-01Z'),
  ('77777777-7777-4777-8777-777777777c10', 6010, 'Mo', 'Shopify', ' Mo@Example.com ', null, '2026-01-01Z');

do $$
begin
  if upsert_customer_if_newer(6100, 'Lin', 'Shopify', 'lin@example.COM', '+1', '2026-10-02Z') <> 'updated' then
    raise exception 'a webhook for a waiver-only email did not update the existing row';
  end if;
  if (select shopify_customer_id || last_name || email || phone from customers
       where id = '77777777-7777-4777-8777-777777777c01') <> '6100Shopifylin@example.COM+1' then
    raise exception 'the oldest waiver-only row was not linked and updated';
  end if;
  if (select shopify_customer_id from customers where id = '77777777-7777-4777-8777-777777777c02') is not null then
    raise exception 'a second waiver-only row with the same email was linked too';
  end if;
  if (select count(*) from customers where lower(btrim(email)) = 'lin@example.com') <> 2 then
    raise exception 'linking inserted a row';
  end if;

  if upsert_customer_if_newer(6100, 'Lin', 'Stale', 'lin@example.com', null, '2026-10-01Z') <> 'stale' then
    raise exception 'an older webhook for a linked customer was not ignored';
  end if;
  if (select last_name from customers where id = '77777777-7777-4777-8777-777777777c01') <> 'Shopify' then
    raise exception 'an older webhook overwrote a linked customer';
  end if;
  if upsert_customer_if_newer(6100, 'Lin', 'Newer', 'lin@example.com', null, '2026-10-03Z') <> 'updated'
     or (select shopify_customer_id from customers where id = '77777777-7777-4777-8777-777777777c02') is not null then
    raise exception 'a newer webhook for a linked customer linked another row';
  end if;

  if upsert_customer_if_newer(6002, 'Ott', 'Other', 'OTT@example.com', null, '2026-10-02Z') <> 'inserted' then
    raise exception 'a row with another Shopify id was adopted';
  end if;
  if (select shopify_customer_id || last_name from customers where id = '77777777-7777-4777-8777-777777777c03') <> '6001Shopify' then
    raise exception 'a row with another Shopify id was changed';
  end if;

  if upsert_customer_if_newer(6004, 'Del', 'New', 'del@example.com', null, '2026-10-02Z') <> 'inserted' then
    raise exception 'a Shopify-deleted row was adopted';
  end if;
  if (select shopify_customer_id from customers where id = '77777777-7777-4777-8777-777777777c04') is not null then
    raise exception 'a Shopify-deleted row was linked';
  end if;

  if upsert_customer_if_newer(6005, 'No', 'Email', null, null, '2026-10-02Z') <> 'inserted'
     or upsert_customer_if_newer(6006, 'Blank', 'Email', '  ', null, '2026-10-02Z') <> 'inserted' then
    raise exception 'a customer without an email was not inserted';
  end if;
  if exists (select 1 from customers
              where id in ('77777777-7777-4777-8777-777777777c05', '77777777-7777-4777-8777-777777777c06')
                and shopify_customer_id is not null) then
    raise exception 'a customer without an email adopted a row';
  end if;
end
$$;

do $$
declare
  v_rows customers[];
begin
  select array_agg(r order by r.shopify_customer_id) into v_rows
    from upsert_shopify_customers(jsonb_build_array(
      jsonb_build_object('shopify_customer_id', 6007, 'first_name', 'Bulk', 'last_name', 'Shopify',
                         'email', 'bulk@EXAMPLE.com', 'phone', null, 'shopify_updated_at', '2026-10-02Z'),
      jsonb_build_object('shopify_customer_id', 6017, 'first_name', 'Bulk', 'last_name', 'Twin',
                         'email', 'bulk@example.com', 'phone', null, 'shopify_updated_at', '2026-10-02Z'),
      jsonb_build_object('shopify_customer_id', 6008, 'first_name', 'New', 'last_name', 'Name',
                         'email', 'known@example.com', 'phone', '+2', 'shopify_updated_at', '2026-10-02Z'),
      jsonb_build_object('shopify_customer_id', 6018, 'first_name', 'Fresh', 'last_name', 'Row',
                         'email', 'fresh@example.com', 'phone', null, 'shopify_updated_at', '2026-10-02Z')
    )) r;
  if array_length(v_rows, 1) <> 4 then
    raise exception 'upsert_shopify_customers returned % rows', array_length(v_rows, 1);
  end if;
  if v_rows[1].id <> '77777777-7777-4777-8777-777777777c07' or v_rows[1].last_name <> 'Shopify' then
    raise exception 'bulk sync did not link the waiver-only row';
  end if;
  if v_rows[3].id = '77777777-7777-4777-8777-777777777c07' then
    raise exception 'bulk sync linked one row to two Shopify customers';
  end if;
  if v_rows[2].id <> '77777777-7777-4777-8777-777777777c08' or v_rows[2].first_name || v_rows[2].phone <> 'New+2' then
    raise exception 'bulk sync did not update a known Shopify customer';
  end if;
  if (select count(*) from customers where lower(btrim(email)) = 'bulk@example.com') <> 2
     or (select count(*) from customers where email = 'fresh@example.com') <> 1 then
    raise exception 'bulk sync inserted the wrong rows';
  end if;

  if (select id from upsert_shopify_customers(jsonb_build_array(
        jsonb_build_object('shopify_customer_id', 6009, 'first_name', 'Admin', 'last_name', 'Made',
                           'email', ' Admin.Made@example.com', 'phone', null, 'shopify_updated_at', null))))
     <> '77777777-7777-4777-8777-777777777c09' then
    raise exception 'admin create did not link the waiver-only row';
  end if;
  if exists (select 1 from upsert_shopify_customers('[]'::jsonb)) then
    raise exception 'an empty batch returned rows';
  end if;
  begin
    perform upsert_shopify_customers('[{"first_name": "No id"}]'::jsonb);
    raise exception 'a customer without a Shopify id was accepted';
  exception when null_value_not_allowed then null;
  end;

  if waiver_customer_for_email('mo@example.com', 'Mo', 'Signer') <> '77777777-7777-4777-8777-777777777c10' then
    raise exception 'waiver_customer_for_email did not ignore spaces around a stored email';
  end if;
end
$$;

create extension if not exists dblink;

do $$
declare
  v_conn text := 'dbname=' || current_database() || ' user=' || current_user;
  v_outcome text;
begin
  perform dblink_connect('link_waiver', v_conn);
  perform dblink_connect('link_shopify', v_conn);

  perform dblink_exec('link_waiver', 'begin');
  perform * from dblink('link_waiver',
    $q$select waiver_customer_for_email('race.one@example.com', 'Race', 'One')$q$) as t (id uuid);
  perform dblink_send_query('link_shopify',
    $q$select upsert_customer_if_newer(6901, 'Race', 'One', 'Race.One@example.com', null, now())$q$);
  perform pg_sleep(0.5);
  if dblink_is_busy('link_shopify') = 0 then
    raise exception 'a Shopify upsert did not wait for a waiver signing of the same email';
  end if;
  perform dblink_exec('link_waiver', 'commit');
  select outcome into v_outcome from dblink_get_result('link_shopify') as t (outcome text);
  perform * from dblink_get_result('link_shopify') as t (outcome text);
  if v_outcome <> 'updated' then
    raise exception 'a Shopify upsert racing a waiver signing returned %', v_outcome;
  end if;

  perform dblink_exec('link_shopify', 'begin');
  perform * from dblink('link_shopify',
    $q$select id from upsert_shopify_customers('[{"shopify_customer_id": 6902, "email": "race.two@example.com"}]')$q$)
    as t (id uuid);
  perform dblink_send_query('link_waiver',
    $q$select waiver_customer_for_email('Race.Two@example.com', 'Race', 'Two')$q$);
  perform pg_sleep(0.5);
  if dblink_is_busy('link_waiver') = 0 then
    raise exception 'a waiver signing did not wait for a Shopify sync of the same email';
  end if;
  perform dblink_exec('link_shopify', 'commit');
  perform * from dblink_get_result('link_waiver') as t (id uuid);
  perform * from dblink_get_result('link_waiver') as t (id uuid);

  if (select count(*) from customers where lower(btrim(email)) = 'race.one@example.com') <> 1
     or (select count(*) from customers where lower(btrim(email)) = 'race.two@example.com') <> 1 then
    raise exception 'a concurrent waiver signing and Shopify sync created two customers';
  end if;
  if (select count(*) from customers where shopify_customer_id in (6901, 6902)) <> 2 then
    raise exception 'a concurrent Shopify sync did not link its customer';
  end if;

  perform dblink_exec('link_waiver',
    $q$delete from customers where shopify_customer_id in (6901, 6902)$q$);
  perform dblink_disconnect('link_waiver');
  perform dblink_disconnect('link_shopify');
end
$$;

set local role anon;
do $$
begin
  perform upsert_shopify_customers('[]'::jsonb);
  raise exception 'anon could call upsert_shopify_customers';
exception when insufficient_privilege then null;
end
$$;
do $$
begin
  perform link_shopify_customer_by_email(1, 'x@example.com');
  raise exception 'anon could call link_shopify_customer_by_email';
exception when insufficient_privilege then null;
end
$$;
reset role;

rollback;
\echo 'Customer email link checks passed.'
