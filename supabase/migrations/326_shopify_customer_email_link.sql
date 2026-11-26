create index if not exists customers_email_key_idx on customers (lower(btrim(email)));

create or replace function public.waiver_customer_for_email(
  p_email text,
  p_first_name text,
  p_last_name text
) returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_email text := lower(btrim(p_email));
  v_id uuid;
begin
  if v_email is null or v_email = '' then
    raise exception 'waiver_customer_for_email needs p_email' using errcode = '22004';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('waiver_customer:' || v_email, 0));

  select c.id into v_id
    from customers c
   where lower(btrim(c.email)) = v_email
   order by (c.shopify_deleted_at is not null),
            (c.shopify_customer_id is null),
            c.created_at,
            c.id
   limit 1;

  if v_id is null then
    insert into customers (first_name, last_name, email)
    values (nullif(btrim(p_first_name), ''), nullif(btrim(p_last_name), ''), v_email)
    returning id into v_id;
  end if;

  return v_id;
end;
$$;

create function public.link_shopify_customer_by_email(
  p_shopify_customer_id bigint,
  p_email text
) returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_email text := lower(btrim(p_email));
begin
  if v_email is null or v_email = '' then
    return;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('waiver_customer:' || v_email, 0));

  if exists (select 1 from customers where shopify_customer_id = p_shopify_customer_id) then
    return;
  end if;

  update customers
     set shopify_customer_id = p_shopify_customer_id
   where id = (
     select c.id
       from customers c
      where lower(btrim(c.email)) = v_email
        and c.shopify_customer_id is null
        and c.shopify_deleted_at is null
      order by c.created_at, c.id
      limit 1
        for update
   );
end;
$$;

revoke all on function public.link_shopify_customer_by_email(bigint, text)
  from public, anon, authenticated;
grant execute on function public.link_shopify_customer_by_email(bigint, text)
  to service_role;

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

  perform link_shopify_customer_by_email(p_shopify_customer_id, p_email);

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

create function public.upsert_shopify_customers(p_customers jsonb)
returns setof customers
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_email text;
  v_row record;
begin
  for v_email in
    select distinct lower(btrim(r.email))
      from jsonb_to_recordset(p_customers) as r (email text)
     where nullif(btrim(r.email), '') is not null
     order by 1
  loop
    perform pg_advisory_xact_lock(hashtextextended('waiver_customer:' || v_email, 0));
  end loop;

  for v_row in
    select r.*
      from jsonb_array_elements(p_customers) with ordinality as e (value, n)
     cross join lateral jsonb_to_record(e.value) as r (
       shopify_customer_id bigint,
       first_name text,
       last_name text,
       email text,
       phone text,
       shopify_updated_at timestamptz
     )
     order by e.n
  loop
    if v_row.shopify_customer_id is null then
      raise exception 'upsert_shopify_customers needs shopify_customer_id'
        using errcode = '22004';
    end if;

    perform link_shopify_customer_by_email(v_row.shopify_customer_id, v_row.email);

    return query
      insert into customers as c (
        shopify_customer_id, first_name, last_name, email, phone, shopify_updated_at
      ) values (
        v_row.shopify_customer_id, v_row.first_name, v_row.last_name,
        v_row.email, v_row.phone, v_row.shopify_updated_at
      )
      on conflict (shopify_customer_id) do update
         set first_name = excluded.first_name,
             last_name = excluded.last_name,
             email = excluded.email,
             phone = excluded.phone,
             shopify_updated_at = excluded.shopify_updated_at
      returning c.*;
  end loop;
end;
$$;

revoke all on function public.upsert_shopify_customers(jsonb)
  from public, anon, authenticated;
grant execute on function public.upsert_shopify_customers(jsonb)
  to service_role;
