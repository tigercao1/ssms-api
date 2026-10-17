\set ON_ERROR_STOP on
begin;

insert into auth.users (id, email) values
  ('11111111-1111-4111-8111-111111111295', 'ci-export-a@example.com'),
  ('11111111-1111-4111-8111-111111111296', 'ci-export-b@example.com'),
  ('11111111-1111-4111-8111-111111111297', 'ci-export-c@example.com'),
  ('11111111-1111-4111-8111-111111111298', 'ci-export-d@example.com');
insert into instructors (id, auth_user_id, email, first_name, last_name) values
  ('22222222-2222-4222-8222-222222222295', '11111111-1111-4111-8111-111111111295',
   'ci-export-a@example.com', 'Ann', 'Zed'),
  ('22222222-2222-4222-8222-222222222296', '11111111-1111-4111-8111-111111111296',
   'ci-export-b@example.com', 'Bob', 'Alpha'),
  ('22222222-2222-4222-8222-222222222297', '11111111-1111-4111-8111-111111111297',
   'ci-export-c@example.com', 'Cy', 'Mid_dle'),
  ('22222222-2222-4222-8222-222222222298', '11111111-1111-4111-8111-111111111298',
   'ci-export-d@example.com', 'Di', 'Gone');
insert into seasons (key, starts_on, ends_on) values ('2025/26', '2025-11-01', '2026-04-30')
  on conflict (key) do nothing;
insert into document_templates (id, kind, audience, title_en) values
  ('33333333-3333-4333-8333-333333333295', 'sign', 'instructor', 'CI export');
insert into document_assignments
  (id, template_id, subject_type, subject_id, season, status, completed_at) values
  ('44444444-4444-4444-8444-444444444291', '33333333-3333-4333-8333-333333333295', 'instructor',
   '22222222-2222-4222-8222-222222222295', '2026/27', 'completed', '2026-10-02T00:00:00Z'),
  ('44444444-4444-4444-8444-444444444292', '33333333-3333-4333-8333-333333333295', 'instructor',
   '22222222-2222-4222-8222-222222222296', '2026/27', 'assigned', null),
  ('44444444-4444-4444-8444-444444444293', '33333333-3333-4333-8333-333333333295', 'instructor',
   '22222222-2222-4222-8222-222222222297', '2026/27', 'viewed', null),
  ('44444444-4444-4444-8444-444444444294', '33333333-3333-4333-8333-333333333295', 'instructor',
   '22222222-2222-4222-8222-222222222298', '2026/27', 'archived', null),
  ('44444444-4444-4444-8444-444444444295', '33333333-3333-4333-8333-333333333295', 'instructor',
   '22222222-2222-4222-8222-222222222296', '2025/26', 'completed', '2026-10-05T00:00:00Z');

do $$
declare
  v_ids uuid[];
  v_total int;
begin
  select array_agg(id order by ord), max(total_count) into v_ids, v_total
  from (
    select id, total_count, row_number() over () as ord
    from public.document_template_assignments(
      '33333333-3333-4333-8333-333333333295', null, 'all', null, null, 50, 0)
  ) t;
  if v_total <> 4 or v_ids <> array[
    '44444444-4444-4444-8444-444444444295', '44444444-4444-4444-8444-444444444291',
    '44444444-4444-4444-8444-444444444292', '44444444-4444-4444-8444-444444444293'
  ]::uuid[] then
    raise exception 'order or archived exclusion wrong: % (total %)', v_ids, v_total;
  end if;

  select count(*) into v_total from public.document_template_assignments(
    '33333333-3333-4333-8333-333333333295', '2026/27', 'open', null, null, 50, 0);
  if v_total <> 2 then
    raise exception 'season + open filter wrong: %', v_total;
  end if;

  select array_agg(id) into v_ids from public.document_template_assignments(
    '33333333-3333-4333-8333-333333333295', null, 'all', array['%mid\_dle%', '%cy%'], null, 50, 0);
  if v_ids <> array['44444444-4444-4444-8444-444444444293']::uuid[] then
    raise exception 'escaped search wrong: %', v_ids;
  end if;

  select count(*) into v_total from public.document_template_assignments(
    '33333333-3333-4333-8333-333333333295', null, 'all', array['%mid\_d_le%'], null, 50, 0);
  if v_total <> 0 then
    raise exception 'escaped underscore matched a wildcard';
  end if;

  select count(*) into v_total from public.document_template_assignments(
    '33333333-3333-4333-8333-333333333295', null, 'completed', null,
    array['44444444-4444-4444-8444-444444444291', '44444444-4444-4444-8444-444444444292']::uuid[],
    50, 0);
  if v_total <> 1 then
    raise exception 'id + completed filter wrong: %', v_total;
  end if;

  select array_agg(id), max(total_count) into v_ids, v_total
  from public.document_template_assignments(
    '33333333-3333-4333-8333-333333333295', null, 'all', null, null, 1, 1);
  if v_total <> 4 or v_ids <> array['44444444-4444-4444-8444-444444444291']::uuid[] then
    raise exception 'paging wrong: % (total %)', v_ids, v_total;
  end if;
end;
$$;

insert into document_exports (id, template_id, requested_by) values
  ('55555555-5555-4555-8555-555555555291', '33333333-3333-4333-8333-333333333295',
   '11111111-1111-4111-8111-111111111295');

do $$
begin
  begin
    insert into document_exports (template_id, requested_by, status) values
      ('33333333-3333-4333-8333-333333333295', '11111111-1111-4111-8111-111111111295', 'done');
    raise exception 'status check missing';
  exception when check_violation then null;
  end;
  begin
    insert into document_exports (template_id, requested_by, assignment_ids) values
      ('33333333-3333-4333-8333-333333333295', '11111111-1111-4111-8111-111111111295', '{}');
    raise exception 'empty selection allowed';
  exception when check_violation then null;
  end;
  if (select status from document_exports
      where id = '55555555-5555-4555-8555-555555555291') <> 'queued' then
    raise exception 'default status is not queued';
  end if;
  if has_table_privilege('authenticated', 'document_exports', 'select')
     or has_table_privilege('anon', 'document_exports', 'select') then
    raise exception 'document_exports is readable by client roles';
  end if;
  if has_function_privilege('authenticated',
       'public.document_template_assignments(uuid, text, text, text[], uuid[], int, int)', 'execute') then
    raise exception 'document_template_assignments is executable by authenticated';
  end if;
  if not (select relforcerowsecurity from pg_class where relname = 'document_exports') then
    raise exception 'RLS not forced on document_exports';
  end if;
end;
$$;

rollback;
\echo 'Document exports checks passed.'
