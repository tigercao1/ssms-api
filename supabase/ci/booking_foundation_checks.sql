\set ON_ERROR_STOP on
begin;

insert into auth.users (id, email)
values ('11111111-1111-4111-8111-111111111111', 'ci-booking@example.com');
insert into instructors (id, auth_user_id, email, display_name_en)
values ('22222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111', 'ci-booking@example.com', 'CI Booking');
insert into customers (id, shopify_customer_id, name)
values ('33333333-3333-4333-8333-333333333333', 1001, 'CI Customer');
insert into lesson_products (id, shopify_product_id, shopify_variant_id, product_title, variant_title, lesson_type, sessions)
values ('44444444-4444-4444-8444-444444444444', 1, 101, '一对一', '四次', 'private', 4);
insert into purchases (id, customer_id, lesson_product_id, shopify_line_item_id, credits_total)
values ('55555555-5555-4555-8555-555555555555', '33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444', 9001, 4);

do $$
begin
  begin
    update purchases set credits_used = 5 where id = '55555555-5555-4555-8555-555555555555';
    raise exception 'credits_used above credits_total was accepted';
  exception when check_violation then null;
  end;
  begin
    update purchases set credits_used = -1 where id = '55555555-5555-4555-8555-555555555555';
    raise exception 'negative credits_used was accepted';
  exception when check_violation then null;
  end;
  update purchases set credits_used = 4 where id = '55555555-5555-4555-8555-555555555555';
  begin
    insert into classes (instructor_id, starts_at, ends_at)
    values ('22222222-2222-4222-8222-222222222222', '2026-12-12 10:00-05', '2026-12-12 10:00-05');
    raise exception 'a class ending when it starts was accepted';
  exception when check_violation then null;
  end;
  insert into classes (instructor_id, starts_at, ends_at)
  values ('22222222-2222-4222-8222-222222222222', '2026-12-12 10:00-05', '2026-12-12 11:00-05');
end
$$;

do $$
declare
  t text;
  r text;
begin
  foreach t in array array['instructor_calendars', 'customers', 'lesson_products', 'purchases', 'classes', 'class_participants'] loop
    if not exists (
      select 1 from pg_class
       where oid = ('public.' || t)::regclass and relrowsecurity and relforcerowsecurity
    ) then
      raise exception '% does not have forced row level security', t;
    end if;
    foreach r in array array['anon', 'authenticated'] loop
      if has_table_privilege(r, 'public.' || t, 'select, insert, update, delete') then
        raise exception '% has privileges on %', r, t;
      end if;
    end loop;
  end loop;
  foreach r in array array['anon', 'authenticated'] loop
    if has_function_privilege(r, 'public.sync_lesson_products(jsonb)', 'execute') then
      raise exception '% can execute sync_lesson_products', r;
    end if;
  end loop;
end
$$;

do $$
declare
  counts record;
  confirmed lesson_products;
  ignored lesson_products;
  suggested lesson_products;
  rows_v1 jsonb := '[
    {"shopify_product_id": 2, "shopify_variant_id": 201, "product_title": "一对二", "variant_title": "单次 每位学员单价", "lesson_type": "semi_private", "group_size": 2, "sessions": 1, "priced_per_student": true, "price": "180.00", "currency": "CAD"},
    {"shopify_product_id": 2, "shopify_variant_id": 202, "product_title": "一对二", "variant_title": "四次 每位学员单价", "lesson_type": "semi_private", "group_size": 2, "sessions": 4, "priced_per_student": true, "price": "680.00", "currency": "CAD"},
    {"shopify_product_id": 2, "shopify_variant_id": 203, "product_title": "一对二", "variant_title": "八次", "lesson_type": "other", "price": "1200.00", "currency": "CAD"}
  ]';
  rows_v2 jsonb := '[
    {"shopify_product_id": 2, "shopify_variant_id": 201, "product_title": "一对二 v2", "variant_title": "单次 每位学员单价", "lesson_type": "group", "sessions": 9, "priced_per_student": false, "price": "190.00", "currency": "CAD"},
    {"shopify_product_id": 2, "shopify_variant_id": 202, "product_title": "一对二 v2", "variant_title": "四次 每位学员单价", "lesson_type": "group", "sessions": 9, "priced_per_student": false, "price": "700.00", "currency": "CAD"},
    {"shopify_product_id": 2, "shopify_variant_id": 203, "product_title": "一对二 v2", "variant_title": "八次", "lesson_type": "semi_private", "group_size": 2, "sessions": 8, "price": "1200.00", "currency": "CAD"}
  ]';
begin
  select * into counts from sync_lesson_products(rows_v1);
  if counts.inserted <> 3 or counts.updated <> 0 then
    raise exception 'first sync wrote % inserted / % updated', counts.inserted, counts.updated;
  end if;

  update lesson_products
     set status = 'confirmed', lesson_type = 'private', group_size = 1, sessions = 2, duration_min = 120
   where shopify_variant_id = 201;
  update lesson_products set status = 'ignored', sessions = 6 where shopify_variant_id = 202;

  select * into counts from sync_lesson_products(rows_v2);
  if counts.inserted <> 0 or counts.updated <> 3 then
    raise exception 'second sync wrote % inserted / % updated', counts.inserted, counts.updated;
  end if;

  select * into confirmed from lesson_products where shopify_variant_id = 201;
  select * into ignored from lesson_products where shopify_variant_id = 202;
  select * into suggested from lesson_products where shopify_variant_id = 203;
  if (confirmed.status, confirmed.lesson_type, confirmed.group_size, confirmed.sessions, confirmed.duration_min, confirmed.priced_per_student)
     is distinct from ('confirmed', 'private', 1, 2, 120, true) then
    raise exception 'sync overwrote a confirmed row: %', row_to_json(confirmed);
  end if;
  if (confirmed.product_title, confirmed.price) is distinct from ('一对二 v2', 190.00::numeric) then
    raise exception 'sync did not refresh title/price on a confirmed row: %', row_to_json(confirmed);
  end if;
  if (ignored.status, ignored.lesson_type, ignored.sessions, ignored.price)
     is distinct from ('ignored', 'semi_private', 6, 700.00::numeric) then
    raise exception 'sync mishandled an ignored row: %', row_to_json(ignored);
  end if;
  if (suggested.status, suggested.lesson_type, suggested.group_size, suggested.sessions)
     is distinct from ('suggested', 'semi_private', 2, 8) then
    raise exception 'sync did not refresh a suggested row: %', row_to_json(suggested);
  end if;

  select * into counts from sync_lesson_products(rows_v2);
  if counts.inserted <> 0 or counts.updated <> 0 then
    raise exception 'identical sync wrote % inserted / % updated', counts.inserted, counts.updated;
  end if;
end
$$;

rollback;
\echo 'Booking foundation checks passed.'
