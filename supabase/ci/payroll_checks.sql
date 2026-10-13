\set ON_ERROR_STOP on
begin;

insert into auth.users (id, email)
values ('11111111-1111-4111-8111-111111111191', 'ci-payroll@example.com');
insert into instructors (id, auth_user_id, email, display_name_en)
values ('22222222-2222-4222-8222-222222222291', '11111111-1111-4111-8111-111111111191', 'ci-payroll@example.com', 'CI Payroll');
insert into lesson_types (id, name_en, group_size, duration_min)
values ('44444444-4444-4444-8444-444444444491', 'Payroll Private 90', 1, 90);
insert into classes (id, instructor_id, lesson_type_id, starts_at, ends_at, status)
values ('55555555-5555-4555-8555-555555555591', '22222222-2222-4222-8222-222222222291',
        '44444444-4444-4444-8444-444444444491', '2026-01-05 15:00-05', '2026-01-05 16:30-05', 'completed');
insert into payroll_periods (id, starts_on, ends_on)
values ('66666666-6666-4666-8666-666666666691', '2025-12-29', '2026-01-11');

do $$
declare
  p constant uuid := '66666666-6666-4666-8666-666666666691';
  i constant uuid := '22222222-2222-4222-8222-222222222291';
begin
  if (select anchor_date from payroll_settings) <> date '2025-12-15' then
    raise exception 'payroll anchor default is not 2025-12-15';
  end if;
  begin
    insert into payroll_settings (id) values (false);
    raise exception 'a second payroll_settings row was accepted';
  exception when check_violation then null;
  end;

  insert into payroll_lines (period_id, instructor_id, kind, description, amount)
  values (p, i, 'adjustment', 'Bonus', -12.5);

  perform public.payroll_finalize(p, jsonb_build_array(jsonb_build_object(
    'instructor_id', i,
    'class_id', '55555555-5555-4555-8555-555555555591',
    'description', 'Payroll Private 90',
    'minutes', 90,
    'hourly_rate', 37.33,
    'currency', 'CAD',
    'amount', 56.00,
    'customer_names', jsonb_build_array('Ada L.'),
    'flags', jsonb_build_array('needs_rate')
  )), null);

  if (select status from payroll_periods where id = p) <> 'finalized' then
    raise exception 'finalize did not mark the period finalized';
  end if;
  if (select flags from payroll_lines where class_id is not null) <> array['needs_rate'] then
    raise exception 'finalize did not keep the line flags';
  end if;
  if (select customer_names from payroll_lines where class_id is not null) <> array['Ada L.'] then
    raise exception 'finalize did not keep the customer names';
  end if;
  if (select sum(amount) from payroll_lines where period_id = p) <> 43.50 then
    raise exception 'finalized lines do not add up';
  end if;

  begin
    update payroll_lines set amount = 1 where period_id = p;
    raise exception 'a finalized line was updated';
  exception when object_not_in_prerequisite_state then null;
  end;
  begin
    delete from payroll_lines where period_id = p;
    raise exception 'a finalized line was deleted';
  exception when object_not_in_prerequisite_state then null;
  end;
  begin
    insert into payroll_lines (period_id, instructor_id, kind, amount)
    values (p, i, 'adjustment', 1);
    raise exception 'a line was added to a finalized period';
  exception when object_not_in_prerequisite_state then null;
  end;
  begin
    perform public.payroll_finalize(p, '[]'::jsonb, null);
    raise exception 'a finalized period was finalized twice';
  exception when object_not_in_prerequisite_state then null;
  end;
  begin
    perform public.payroll_set_anchor('2025-12-22', null);
    raise exception 'the anchor moved while a period is finalized';
  exception when object_not_in_prerequisite_state then null;
  end;

  perform public.payroll_reopen(p);
  if (select count(*) from payroll_lines where period_id = p) <> 1 then
    raise exception 'reopen did not drop the class lines and keep adjustments';
  end if;
  begin
    perform public.payroll_reopen(p);
    raise exception 'an open period was reopened';
  exception when object_not_in_prerequisite_state then null;
  end;
  begin
    perform public.payroll_reopen(gen_random_uuid());
    raise exception 'an unknown period was reopened';
  exception when no_data_found then null;
  end;
  begin
    perform public.payroll_set_anchor('2025-12-22', null);
    raise exception 'the anchor moved while adjustments exist in a misaligned period';
  exception when object_not_in_prerequisite_state then null;
  end;
  perform public.payroll_set_anchor('2025-11-17', null);
  if not exists (select 1 from payroll_periods where id = p) then
    raise exception 'an aligned period was dropped by an anchor change';
  end if;
  begin
    insert into payroll_periods (starts_on, ends_on) values ('2026-01-12', '2026-01-26');
    raise exception 'a period that is not 14 days was accepted';
  exception when check_violation then null;
  end;

  delete from payroll_lines where period_id = p;
  perform public.payroll_set_anchor('2025-12-22', null);
  if (select anchor_date from payroll_settings) <> date '2025-12-22' then
    raise exception 'the anchor did not move';
  end if;
  if exists (select 1 from payroll_periods where id = p) then
    raise exception 'a misaligned open period survived the anchor change';
  end if;
end
$$;

do $$
declare
  t text;
  f text;
  r text;
begin
  foreach t in array array['payroll_settings', 'payroll_periods', 'payroll_lines'] loop
    if not (select relrowsecurity and relforcerowsecurity from pg_class where oid = ('public.' || t)::regclass) then
      raise exception '% does not have forced row level security', t;
    end if;
    foreach r in array array['anon', 'authenticated'] loop
      if has_table_privilege(r, 'public.' || t, 'select, insert, update, delete') then
        raise exception '% has privileges on %', r, t;
      end if;
    end loop;
  end loop;
  foreach f in array array[
    'public.payroll_finalize(uuid, jsonb, uuid)',
    'public.payroll_reopen(uuid)',
    'public.payroll_set_anchor(date, uuid)',
    'public.payroll_lines_guard_finalized()'
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
  end loop;
end
$$;

rollback;
\echo 'Payroll checks passed.'
