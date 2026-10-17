create or replace function public.lesson_insurance_register(
  p_instructor_id uuid,
  p_kind text,
  p_season_key text,
  p_lesson_date date,
  p_duration_hours int,
  p_location_id uuid,
  p_location_other text,
  p_students jsonb,
  p_top_up boolean,
  p_idempotency_key uuid,
  p_actor uuid
) returns jsonb
language plpgsql
set search_path = public
as $$
declare
  c_cap constant int := 40000;
  v_existing uuid;
  v_season text;
  v_owed int;
  v_list int;
  v_amount int;
  v_coverage text;
  v_status text;
  v_count int;
  v_day date;
  v_no int;
  v_id uuid;
begin
  if p_kind not in ('lesson', 'season_pass') then
    raise exception 'unknown insurance record kind %', p_kind using errcode = '22023';
  end if;

  select id into v_existing from lesson_insurance_records
   where instructor_id = p_instructor_id and idempotency_key = p_idempotency_key;
  if found then
    return jsonb_build_object('outcome', 'existing', 'id', v_existing);
  end if;

  if p_kind = 'lesson' then
    select key into v_season from seasons
     where p_lesson_date between starts_on and ends_on;
  else
    select key into v_season from seasons where key = p_season_key;
  end if;
  if v_season is null then
    return jsonb_build_object('outcome', 'no_season');
  end if;

  perform pg_advisory_xact_lock(
    hashtext('lesson_insurance'),
    hashtext(p_instructor_id::text || '|' || v_season)
  );

  select id into v_existing from lesson_insurance_records
   where instructor_id = p_instructor_id and idempotency_key = p_idempotency_key;
  if found then
    return jsonb_build_object('outcome', 'existing', 'id', v_existing);
  end if;

  select coalesce(sum(amount_cents), 0)::int into v_owed
    from lesson_insurance_records
   where instructor_id = p_instructor_id
     and season_key = v_season
     and payment_status <> 'voided';

  if p_kind = 'lesson' then
    v_count := jsonb_array_length(p_students);
    v_list := 1000 * p_duration_hours * least(v_count, 4);
    if v_owed >= c_cap then
      v_amount := 0;
      v_status := 'not_required';
      v_coverage := case when exists (
        select 1 from lesson_insurance_records
         where instructor_id = p_instructor_id
           and season_key = v_season
           and kind = 'season_pass'
           and payment_status <> 'voided'
      ) then 'season_pass' else 'capped' end;
    elsif v_owed + v_list >= c_cap then
      v_amount := c_cap - v_owed;
      v_coverage := 'cap_top_up';
      v_status := 'unpaid';
    else
      v_amount := v_list;
      v_coverage := 'per_lesson';
      v_status := 'unpaid';
    end if;
  else
    if exists (
      select 1 from lesson_insurance_records
       where instructor_id = p_instructor_id
         and season_key = v_season
         and kind = 'season_pass'
         and payment_status <> 'voided'
    ) then
      return jsonb_build_object(
        'outcome', 'already_has_pass',
        'season_key', v_season,
        'owed_cents', v_owed
      );
    end if;
    if v_owed >= c_cap then
      return jsonb_build_object(
        'outcome', 'already_covered',
        'season_key', v_season,
        'owed_cents', v_owed
      );
    end if;
    v_list := c_cap;
    v_amount := c_cap - v_owed;
    v_coverage := null;
    v_status := 'unpaid';
  end if;

  v_day := (now() at time zone 'America/Toronto')::date;
  insert into lesson_insurance_record_counters as c (day, last_no)
  values (v_day, 1)
  on conflict (day) do update set last_no = c.last_no + 1
  returning last_no into v_no;

  insert into lesson_insurance_records (
    instructor_id, season_key, kind, lesson_date, duration_hours, location_id,
    location_other, students, student_count, list_cents, amount_cents, coverage,
    payment_status, record_no, idempotency_key, created_by
  ) values (
    p_instructor_id, v_season, p_kind,
    case when p_kind = 'lesson' then p_lesson_date end,
    case when p_kind = 'lesson' then p_duration_hours end,
    case when p_kind = 'lesson' then p_location_id end,
    case when p_kind = 'lesson' then p_location_other end,
    case when p_kind = 'lesson' then p_students end,
    v_count, v_list, v_amount, v_coverage, v_status,
    'INS-' || to_char(v_day, 'YYYYMMDD') || '-' || lpad(v_no::text, 4, '0'),
    p_idempotency_key, p_actor
  )
  returning id into v_id;

  return jsonb_build_object('outcome', 'created', 'id', v_id);
end;
$$;

revoke all on function public.lesson_insurance_register(uuid, text, text, date, int, uuid, text, jsonb, boolean, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.lesson_insurance_register(uuid, text, text, date, int, uuid, text, jsonb, boolean, uuid, uuid)
  to service_role;

create or replace function public.lesson_insurance_admin_grant_pass(
  p_instructor_id uuid,
  p_season_key text,
  p_actor uuid,
  p_idempotency_key uuid,
  p_paid_on date,
  p_paid_note text
) returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_result jsonb;
begin
  v_result := public.lesson_insurance_register(
    p_instructor_id, 'season_pass', p_season_key, null, null, null, null, null,
    false, p_idempotency_key, p_actor
  );

  if p_paid_on is not null and v_result ->> 'outcome' = 'created' then
    update lesson_insurance_records
       set payment_status = 'paid',
           paid_on = p_paid_on,
           paid_note = p_paid_note,
           paid_by = p_actor
     where id = (v_result ->> 'id')::uuid;
  end if;

  return v_result;
end;
$$;

revoke all on function public.lesson_insurance_admin_grant_pass(uuid, text, uuid, uuid, date, text)
  from public, anon, authenticated;
grant execute on function public.lesson_insurance_admin_grant_pass(uuid, text, uuid, uuid, date, text)
  to service_role;
