create table if not exists daily_reminder_runs (
  run_day               date primary key,
  lock_token            uuid,
  locked_until          timestamptz,
  attempts              int not null default 0
                          constraint daily_reminder_runs_attempts_check
                          check (attempts >= 0),
  started_at            timestamptz,
  finished_at           timestamptz,
  documents_sent        int
                          constraint daily_reminder_runs_documents_sent_check
                          check (documents_sent >= 0),
  documents_error       text
                          constraint daily_reminder_runs_documents_error_check
                          check (char_length(documents_error) <= 2000),
  certifications_sent   int
                          constraint daily_reminder_runs_certifications_sent_check
                          check (certifications_sent >= 0),
  certifications_error  text
                          constraint daily_reminder_runs_certifications_error_check
                          check (char_length(certifications_error) <= 2000),
  invites_sent          int
                          constraint daily_reminder_runs_invites_sent_check
                          check (invites_sent >= 0),
  invites_error         text
                          constraint daily_reminder_runs_invites_error_check
                          check (char_length(invites_error) <= 2000),
  updated_at            timestamptz not null default now()
);

create or replace trigger daily_reminder_runs_set_updated_at
  before update on daily_reminder_runs
  for each row execute function public.set_updated_at();

alter table daily_reminder_runs enable row level security;
alter table daily_reminder_runs force row level security;
revoke all on daily_reminder_runs from public, anon, authenticated;

create or replace function public.try_start_daily_reminders(
  p_day date,
  p_lease_seconds int
) returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_token uuid;
begin
  if not pg_try_advisory_xact_lock(hashtextextended('daily_reminders', 0)) then
    return null;
  end if;

  insert into daily_reminder_runs (run_day) values (p_day)
    on conflict (run_day) do nothing;

  update daily_reminder_runs
     set lock_token = gen_random_uuid(),
         locked_until = now() + make_interval(secs => p_lease_seconds),
         attempts = attempts + 1,
         started_at = now()
   where run_day = p_day
     and finished_at is null
     and (locked_until is null or locked_until <= now())
  returning lock_token into v_token;

  return v_token;
end;
$$;

revoke all on function public.try_start_daily_reminders(date, int)
  from public, anon, authenticated;
grant execute on function public.try_start_daily_reminders(date, int)
  to service_role;

create or replace function public.finish_daily_reminders(
  p_token uuid,
  p_documents_sent int,
  p_documents_error text,
  p_certifications_sent int,
  p_certifications_error text,
  p_invites_sent int,
  p_invites_error text
) returns boolean
language plpgsql
security invoker
set search_path = public
as $$
begin
  update daily_reminder_runs
     set lock_token = null,
         locked_until = null,
         finished_at = now(),
         documents_sent = p_documents_sent,
         documents_error = p_documents_error,
         certifications_sent = p_certifications_sent,
         certifications_error = p_certifications_error,
         invites_sent = p_invites_sent,
         invites_error = p_invites_error
   where lock_token = p_token;
  return found;
end;
$$;

revoke all on function public.finish_daily_reminders(uuid, int, text, int, text, int, text)
  from public, anon, authenticated;
grant execute on function public.finish_daily_reminders(uuid, int, text, int, text, int, text)
  to service_role;
