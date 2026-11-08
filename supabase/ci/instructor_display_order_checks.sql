\set ON_ERROR_STOP on
\o /dev/null
begin;

insert into auth.users (id, email)
select ('11111111-1111-4111-8111-1111111115' || lpad(n::text, 2, '0'))::uuid,
       'ci-order-' || n || '@example.com'
  from generate_series(1, 9) n;

insert into instructors (id, auth_user_id, email, approval_status, is_active, display_order) values
  ('22222222-2222-4222-8222-222222222501', '11111111-1111-4111-8111-111111111501', 'ci-order-1@example.com', 'approved', true, 900),
  ('22222222-2222-4222-8222-222222222502', '11111111-1111-4111-8111-111111111502', 'ci-order-2@example.com', 'pending', true, null),
  ('22222222-2222-4222-8222-222222222503', '11111111-1111-4111-8111-111111111503', 'ci-order-3@example.com', 'pending', true, 5),
  ('22222222-2222-4222-8222-222222222504', '11111111-1111-4111-8111-111111111504', 'ci-order-4@example.com', 'rejected', true, 7),
  ('22222222-2222-4222-8222-222222222505', '11111111-1111-4111-8111-111111111505', 'ci-order-5@example.com', 'pending', false, null),
  ('22222222-2222-4222-8222-222222222506', '11111111-1111-4111-8111-111111111506', 'ci-order-6@example.com', 'pending', true, null),
  ('22222222-2222-4222-8222-222222222507', '11111111-1111-4111-8111-111111111507', 'ci-order-7@example.com', 'pending', true, null);

alter table instructors disable trigger instructors_assign_display_order;
insert into instructors (id, auth_user_id, email, approval_status, is_active, display_order) values
  ('22222222-2222-4222-8222-222222222508', '11111111-1111-4111-8111-111111111508', 'ci-order-8@example.com', 'approved', true, null);
alter table instructors enable trigger instructors_assign_display_order;

create function pg_temp.order_of(p_id uuid) returns int language sql as $$
  select display_order from instructors where id = p_id;
$$;

do $$
declare
  got int;
begin
  update instructors set approval_status = 'approved'
   where id = '22222222-2222-4222-8222-222222222502';
  got := pg_temp.order_of('22222222-2222-4222-8222-222222222502');
  if got is distinct from 901 then
    raise exception 'approval should assign max + 1 = 901, got %', got;
  end if;

  update instructors set approval_status = 'approved'
   where id = '22222222-2222-4222-8222-222222222503';
  got := pg_temp.order_of('22222222-2222-4222-8222-222222222503');
  if got is distinct from 5 then
    raise exception 'approval overwrote an admin-set order: %', got;
  end if;

  update instructors set approval_status = 'approved'
   where id = '22222222-2222-4222-8222-222222222504';
  got := pg_temp.order_of('22222222-2222-4222-8222-222222222504');
  if got is distinct from 7 then
    raise exception 're-approval should keep its order 7, got %', got;
  end if;

  update instructors set approval_status = 'approved'
   where id = '22222222-2222-4222-8222-222222222505';
  got := pg_temp.order_of('22222222-2222-4222-8222-222222222505');
  if got is not null then
    raise exception 'an inactive approved instructor should stay unordered, got %', got;
  end if;
  update instructors set is_active = true
   where id = '22222222-2222-4222-8222-222222222505';
  got := pg_temp.order_of('22222222-2222-4222-8222-222222222505');
  if got is distinct from 902 then
    raise exception 'going live should assign 902, got %', got;
  end if;

  update instructors set is_active = false
   where id = '22222222-2222-4222-8222-222222222502';
  update instructors set is_active = true
   where id = '22222222-2222-4222-8222-222222222502';
  got := pg_temp.order_of('22222222-2222-4222-8222-222222222502');
  if got is distinct from 901 then
    raise exception 'reactivation should keep its order 901, got %', got;
  end if;

  update instructors set approval_status = 'approved', is_active = true, display_name_en = 'Unordered'
   where id = '22222222-2222-4222-8222-222222222508';
  got := pg_temp.order_of('22222222-2222-4222-8222-222222222508');
  if got is not null then
    raise exception 'an already live unordered instructor should not be backfilled, got %', got;
  end if;

  update instructors set display_order = null
   where id = '22222222-2222-4222-8222-222222222501';
  got := pg_temp.order_of('22222222-2222-4222-8222-222222222501');
  if got is not null then
    raise exception 'an admin clearing the order should stick, got %', got;
  end if;

  update instructors set approval_status = 'approved'
   where id in ('22222222-2222-4222-8222-222222222506', '22222222-2222-4222-8222-222222222507');
  if (select array_agg(display_order order by display_order) from instructors
       where id in ('22222222-2222-4222-8222-222222222506', '22222222-2222-4222-8222-222222222507'))
     is distinct from array[903, 904] then
    raise exception 'two approvals in one statement should get 903 and 904';
  end if;

  insert into instructors (id, auth_user_id, email, approval_status, is_active)
  values ('22222222-2222-4222-8222-222222222509', '11111111-1111-4111-8111-111111111509',
          'ci-order-9@example.com', 'approved', true);
  got := pg_temp.order_of('22222222-2222-4222-8222-222222222509');
  if got is distinct from 905 then
    raise exception 'inserting a live instructor should assign 905, got %', got;
  end if;
end
$$;

rollback;

create extension if not exists dblink;

insert into auth.users (id, email) values
  ('11111111-1111-4111-8111-111111111511', 'ci-order-11@example.com'),
  ('11111111-1111-4111-8111-111111111512', 'ci-order-12@example.com');
insert into instructors (id, auth_user_id, email, approval_status, is_active) values
  ('22222222-2222-4222-8222-222222222511', '11111111-1111-4111-8111-111111111511', 'ci-order-11@example.com', 'pending', true),
  ('22222222-2222-4222-8222-222222222512', '11111111-1111-4111-8111-111111111512', 'ci-order-12@example.com', 'pending', true);

do $$
declare
  conn text := 'dbname=' || current_database()
    || ' user=' || current_user
    || ' port=' || current_setting('port')
    || ' host=' || split_part(current_setting('unix_socket_directories'), ',', 1);
  base int := (select coalesce(max(display_order), 0) from instructors);
  first int;
  second int;
begin
  perform dblink_connect('order_one', conn);
  perform dblink_connect('order_two', conn);
  perform dblink_exec('order_one', 'begin');
  perform dblink_exec('order_one',
    'update instructors set approval_status = ''approved'' where id = ''22222222-2222-4222-8222-222222222511''');
  perform dblink_send_query('order_two',
    'update instructors set approval_status = ''approved'' where id = ''22222222-2222-4222-8222-222222222512''');
  perform pg_sleep(0.5);
  if dblink_is_busy('order_two') <> 1 then
    raise exception 'the second approval did not wait for the first';
  end if;
  perform dblink_exec('order_one', 'commit');
  perform * from dblink_get_result('order_two') as t(r text);
  perform dblink_disconnect('order_one');
  perform dblink_disconnect('order_two');

  first := (select display_order from instructors where id = '22222222-2222-4222-8222-222222222511');
  second := (select display_order from instructors where id = '22222222-2222-4222-8222-222222222512');
  if first is distinct from base + 1 or second is distinct from base + 2 then
    raise exception 'two concurrent approvals should get % and %, got % and %',
      base + 1, base + 2, first, second;
  end if;
end
$$;

delete from instructors
 where id in ('22222222-2222-4222-8222-222222222511', '22222222-2222-4222-8222-222222222512');
delete from auth.users
 where id in ('11111111-1111-4111-8111-111111111511', '11111111-1111-4111-8111-111111111512');

\o
\echo 'Instructor display order checks passed.'
