\set ON_ERROR_STOP on
begin;

do $$
declare
  v_first uuid;
  v_retake uuid;
  v_next uuid;
begin
  v_first := try_start_daily_reminders('2026-10-17', 1800);
  if v_first is null then
    raise exception 'the first run of a day did not start';
  end if;
  if try_start_daily_reminders('2026-10-17', 1800) is not null then
    raise exception 'a second run started while the first held the lease';
  end if;

  update daily_reminder_runs set locked_until = now() - interval '1 second'
   where run_day = '2026-10-17';
  v_retake := try_start_daily_reminders('2026-10-17', 1800);
  if v_retake is null or v_retake = v_first then
    raise exception 'an expired lease was not taken over with a new token';
  end if;
  if finish_daily_reminders(v_first, 1, null, 0, null, 0, null) then
    raise exception 'a run that lost its lease recorded a finish';
  end if;
  if not finish_daily_reminders(v_retake, 2, null, 1, 'mailer down', 3, null) then
    raise exception 'the lease holder could not record its finish';
  end if;
  if (select (attempts, documents_sent, certifications_error, invites_sent, lock_token)
             is distinct from (2, 2, 'mailer down'::text, 3, null::uuid)
        from daily_reminder_runs where run_day = '2026-10-17') then
    raise exception 'the finished run was not recorded';
  end if;
  if try_start_daily_reminders('2026-10-17', 1800) is not null then
    raise exception 'a finished day ran again';
  end if;

  v_next := try_start_daily_reminders('2026-10-18', 1800);
  if v_next is null then
    raise exception 'a failed part blocked the next day';
  end if;

  begin
    perform finish_daily_reminders(v_next, -1, null, 0, null, 0, null);
    raise exception 'a negative count was accepted';
  exception when check_violation then null;
  end;
  begin
    perform finish_daily_reminders(v_next, 0, repeat('x', 2001), 0, null, 0, null);
    raise exception 'an oversized error was accepted';
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
     where oid = 'public.daily_reminder_runs'::regclass and relrowsecurity and relforcerowsecurity
  ) then
    raise exception 'daily_reminder_runs does not have forced row level security';
  end if;
  foreach r in array array['anon', 'authenticated'] loop
    if has_table_privilege(r, 'public.daily_reminder_runs', 'select, insert, update, delete') then
      raise exception '% has privileges on daily_reminder_runs', r;
    end if;
  end loop;
  foreach f in array array[
    'public.try_start_daily_reminders(date, int)',
    'public.finish_daily_reminders(uuid, int, text, int, text, int, text)'
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

rollback;
\echo 'Daily reminders checks passed.'
