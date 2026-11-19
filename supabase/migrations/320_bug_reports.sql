create table if not exists bug_reports (
  id              uuid primary key default gen_random_uuid(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  reporter_id     uuid not null,
  reporter_name   text not null check (char_length(reporter_name) <= 200),
  reporter_email  text check (char_length(reporter_email) <= 320),
  reporter_role   text not null check (reporter_role in ('admin', 'instructor')),
  description     text not null check (char_length(btrim(description)) between 1 and 4000),
  expected        text check (char_length(expected) <= 2000),
  severity        text check (severity in ('blocked', 'wrong', 'minor')),
  page_url        text not null check (char_length(page_url) <= 500),
  app_version     text check (char_length(app_version) <= 64),
  viewport        text check (char_length(viewport) <= 32),
  user_agent      text check (char_length(user_agent) <= 300),
  screenshot_key  text check (screenshot_key ~ '^bug-reports/[0-9a-f-]{36}/[0-9a-f-]{36}\.(png|jpg|webp)$'),
  status          text not null default 'new' check (status in ('new', 'in_progress', 'resolved', 'wont_fix')),
  admin_note      text check (char_length(admin_note) <= 2000)
);

create index if not exists bug_reports_status_created_idx
  on bug_reports (status, created_at desc);
create index if not exists bug_reports_reporter_created_idx
  on bug_reports (reporter_id, created_at desc);

create or replace trigger bug_reports_set_updated_at
  before update on bug_reports
  for each row execute function public.set_updated_at();

alter table bug_reports enable row level security;
alter table bug_reports force row level security;
revoke all on bug_reports from public, anon, authenticated;

create or replace function public.submit_bug_report(
  p_report jsonb,
  p_hourly_limit_per_reporter int,
  p_minute_limit int
) returns table (id uuid, created_at timestamptz, limited text)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_reporter uuid := (p_report ->> 'reporter_id')::uuid;
begin
  perform pg_advisory_xact_lock(hashtext('bug_reports'));

  if (select count(*) from bug_reports b
       where b.reporter_id = v_reporter
         and b.created_at > now() - interval '1 hour') >= p_hourly_limit_per_reporter then
    return query select null::uuid, null::timestamptz, 'reporter'::text;
    return;
  end if;

  if (select count(*) from bug_reports b
       where b.created_at > now() - interval '1 minute') >= p_minute_limit then
    return query select null::uuid, null::timestamptz, 'global'::text;
    return;
  end if;

  return query
    insert into bug_reports as b
    select * from jsonb_populate_record(null::bug_reports, p_report || jsonb_build_object(
      'id', gen_random_uuid(), 'created_at', now(), 'updated_at', now(),
      'status', 'new', 'admin_note', null))
    returning b.id, b.created_at, null::text;
end;
$$;

revoke all on function public.submit_bug_report(jsonb, int, int)
  from public, anon, authenticated;
grant execute on function public.submit_bug_report(jsonb, int, int)
  to service_role;

create table if not exists bug_report_screenshots (
  key          text primary key check (key ~ '^bug-reports/[0-9a-f-]{36}/[0-9a-f-]{36}\.(png|jpg|webp)$'),
  reporter_id  uuid not null,
  created_at   timestamptz not null default now()
);

create index if not exists bug_report_screenshots_reporter_created_idx
  on bug_report_screenshots (reporter_id, created_at desc);
create index if not exists bug_report_screenshots_created_idx
  on bug_report_screenshots (created_at desc);

alter table bug_report_screenshots enable row level security;
alter table bug_report_screenshots force row level security;
revoke all on bug_report_screenshots from public, anon, authenticated;

create or replace function public.issue_bug_report_screenshot(
  p_reporter uuid,
  p_key text,
  p_hourly_limit_per_reporter int,
  p_minute_limit int
) returns text
language plpgsql
security invoker
set search_path = public
as $$
begin
  perform pg_advisory_xact_lock(hashtext('bug_report_screenshots'));

  if (select count(*) from bug_report_screenshots s
       where s.reporter_id = p_reporter
         and s.created_at > now() - interval '1 hour') >= p_hourly_limit_per_reporter then
    return 'reporter';
  end if;

  if (select count(*) from bug_report_screenshots s
       where s.created_at > now() - interval '1 minute') >= p_minute_limit then
    return 'global';
  end if;

  insert into bug_report_screenshots (key, reporter_id) values (p_key, p_reporter);
  return null;
end;
$$;

revoke all on function public.issue_bug_report_screenshot(uuid, text, int, int)
  from public, anon, authenticated;
grant execute on function public.issue_bug_report_screenshot(uuid, text, int, int)
  to service_role;
