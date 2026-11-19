\set ON_ERROR_STOP on
begin;

create function pg_temp.report(p_reporter uuid, p_extra jsonb default '{}')
returns jsonb language sql as $$
  select jsonb_build_object(
    'reporter_id', p_reporter, 'reporter_name', 'CI Reporter',
    'reporter_email', 'ci-bug@example.com', 'reporter_role', 'instructor',
    'description', 'The save button does nothing', 'page_url', '/me/instructor'
  ) || p_extra;
$$;

do $$
declare
  a constant uuid := '11111111-1111-4111-8111-1111111111c1';
  b constant uuid := '11111111-1111-4111-8111-1111111111c2';
  r record;
  row bug_reports;
begin
  select * into r from submit_bug_report(pg_temp.report(a), 2, 3);
  if r.id is null or r.limited is not null then
    raise exception 'a first report was not stored: %', r;
  end if;
  select * into row from bug_reports where id = r.id;
  if row.status <> 'new' or row.severity is not null or row.admin_note is not null
     or row.reporter_role <> 'instructor' or row.created_at <> row.updated_at then
    raise exception 'a new report has the wrong defaults: %', row;
  end if;

  perform submit_bug_report(pg_temp.report(a), 2, 3);
  select * into r from submit_bug_report(pg_temp.report(a), 2, 3);
  if r.id is not null or r.limited <> 'reporter' then
    raise exception 'a third report in the hour was not limited per reporter: %', r;
  end if;

  select * into r from submit_bug_report(pg_temp.report(b), 2, 3);
  if r.id is null then
    raise exception 'another reporter was limited by the first one: %', r;
  end if;
  select * into r from submit_bug_report(pg_temp.report(b), 2, 3);
  if r.id is not null or r.limited <> 'global' then
    raise exception 'the per-minute ceiling did not apply: %', r;
  end if;

  update bug_reports set created_at = now() - interval '2 hours' where reporter_id = a;
  select * into r from submit_bug_report(pg_temp.report(a), 2, 10);
  if r.id is null then
    raise exception 'reports older than an hour still counted: %', r;
  end if;

  update bug_reports set status = 'resolved', updated_at = '2000-01-01'
   where id = r.id returning * into row;
  if row.updated_at <> now() then
    raise exception 'updated_at was not set by the trigger: %', row;
  end if;

  begin
    update bug_reports set status = 'done' where id = r.id;
    raise exception 'an unknown status was accepted';
  exception when check_violation then null;
  end;
  begin
    perform submit_bug_report(pg_temp.report(b, '{"severity": "urgent"}'), 99, 99);
    raise exception 'an unknown severity was accepted';
  exception when check_violation then null;
  end;
  begin
    perform submit_bug_report(pg_temp.report(b, '{"description": "   "}'), 99, 99);
    raise exception 'a blank description was accepted';
  exception when check_violation then null;
  end;
  begin
    perform submit_bug_report(pg_temp.report(b, jsonb_build_object('description', repeat('x', 4001))), 99, 99);
    raise exception 'a description over 4000 characters was accepted';
  exception when check_violation then null;
  end;
  begin
    perform submit_bug_report(pg_temp.report(b, jsonb_build_object('page_url', repeat('x', 501))), 99, 99);
    raise exception 'a page URL over 500 characters was accepted';
  exception when check_violation then null;
  end;
  begin
    perform submit_bug_report(pg_temp.report(b, '{"screenshot_key": "documents/secret.pdf"}'), 99, 99);
    raise exception 'a screenshot key outside bug-reports/ was accepted';
  exception when check_violation then null;
  end;
  begin
    perform submit_bug_report(pg_temp.report(b, '{"reporter_role": "anon"}'), 99, 99);
    raise exception 'an unknown reporter role was accepted';
  exception when check_violation then null;
  end;
  begin
    perform submit_bug_report(pg_temp.report(b) - 'reporter_id', 99, 99);
    raise exception 'a report without a reporter was accepted';
  exception when not_null_violation then null;
  end;
end
$$;

do $$
declare
  f constant text := 'public.submit_bug_report(jsonb, int, int)';
  r text;
begin
  if not exists (
    select 1 from pg_class
     where oid = 'public.bug_reports'::regclass
       and relrowsecurity and relforcerowsecurity
  ) then
    raise exception 'bug_reports does not have forced row level security';
  end if;
  if exists (select 1 from pg_policies where tablename = 'bug_reports') then
    raise exception 'bug_reports has a row level security policy';
  end if;
  if not exists (
    select 1 from pg_indexes
     where tablename = 'bug_reports'
       and indexdef like '%(status, created_at DESC)%'
  ) then
    raise exception 'bug_reports has no (status, created_at desc) index';
  end if;
  foreach r in array array['anon', 'authenticated'] loop
    if has_table_privilege(r, 'public.bug_reports', 'select, insert, update, delete') then
      raise exception '% has privileges on bug_reports', r;
    end if;
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
end
$$;

rollback;
\echo 'Bug report checks passed.'
