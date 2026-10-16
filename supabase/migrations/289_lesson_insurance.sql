create or replace function public.lesson_insurance_students_valid(p_students jsonb)
returns boolean
language sql
immutable
set search_path = public
as $$
  select jsonb_typeof(p_students) = 'array'
     and jsonb_array_length(p_students) between 1 and 50
     and not exists (
       select 1 from jsonb_array_elements(p_students) s
        where jsonb_typeof(s) <> 'object'
           or jsonb_typeof(s -> 'name') is distinct from 'string'
           or char_length(s ->> 'name') not between 1 and 200
           or btrim(s ->> 'name') <> (s ->> 'name')
           or (s -> 'waiverConfirmed') is distinct from 'true'::jsonb
     );
$$;

revoke all on function public.lesson_insurance_students_valid(jsonb)
  from public, anon, authenticated;

create table if not exists lesson_insurance_records (
  id                  uuid primary key default gen_random_uuid(),
  instructor_id       uuid not null references instructors (id),
  season_key          text not null references seasons (key) on update cascade,
  kind                text not null
                        constraint lesson_insurance_records_kind_check
                        check (kind in ('lesson', 'season_pass')),
  lesson_date         date,
  duration_hours      int
                        constraint lesson_insurance_records_duration_check
                        check (duration_hours in (1, 2)),
  location_id         uuid references teaching_locations (id),
  location_other      text
                        constraint lesson_insurance_records_location_other_check
                        check (char_length(location_other) between 1 and 200),
  students            jsonb
                        constraint lesson_insurance_records_students_check
                        check (public.lesson_insurance_students_valid(students)),
  student_count       int,
  list_cents          int not null
                        constraint lesson_insurance_records_list_cents_check
                        check (list_cents >= 0),
  amount_cents        int not null
                        constraint lesson_insurance_records_amount_cents_check
                        check (amount_cents between 0 and 40000),
  coverage            text
                        constraint lesson_insurance_records_coverage_check
                        check (coverage in ('per_lesson', 'cap_top_up', 'capped', 'season_pass')),
  payment_status      text not null
                        constraint lesson_insurance_records_payment_status_check
                        check (payment_status in ('unpaid', 'paid', 'not_required', 'voided')),
  paid_on             date,
  paid_note           text
                        constraint lesson_insurance_records_paid_note_check
                        check (char_length(paid_note) <= 500),
  paid_by             uuid,
  voided_at           timestamptz,
  voided_reason       text
                        constraint lesson_insurance_records_voided_reason_check
                        check (char_length(voided_reason) between 1 and 500),
  voided_by           uuid,
  voided_from_status  text
                        constraint lesson_insurance_records_voided_from_status_check
                        check (voided_from_status in ('unpaid', 'paid', 'not_required')),
  record_no           text not null
                        constraint lesson_insurance_records_record_no_key unique
                        constraint lesson_insurance_records_record_no_check
                        check (record_no ~ '^INS-\d{8}-\d{4}$'),
  idempotency_key     uuid,
  created_by          uuid,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint lesson_insurance_records_idempotency_key
    unique (instructor_id, idempotency_key),
  constraint lesson_insurance_records_kind_fields_check check (
    (kind = 'lesson'
      and lesson_date is not null
      and duration_hours is not null
      and students is not null
      and student_count = jsonb_array_length(students)
      and coverage is not null
      and not (location_id is not null and location_other is not null))
    or (kind = 'season_pass'
      and lesson_date is null
      and duration_hours is null
      and location_id is null
      and location_other is null
      and students is null
      and student_count is null
      and coverage is null)
  ),
  constraint lesson_insurance_records_paid_check
    check ((payment_status = 'paid') = (paid_on is not null)),
  constraint lesson_insurance_records_voided_check
    check ((payment_status = 'voided') = (
      voided_at is not null and voided_reason is not null and voided_from_status is not null
    ))
);

create index if not exists lesson_insurance_records_instructor_season_idx
  on lesson_insurance_records (instructor_id, season_key);
create index if not exists lesson_insurance_records_season_status_idx
  on lesson_insurance_records (season_key, payment_status);

create or replace trigger lesson_insurance_records_set_updated_at
  before update on lesson_insurance_records
  for each row execute function public.set_updated_at();

create table if not exists lesson_insurance_record_counters (
  day      date primary key,
  last_no  int not null
             constraint lesson_insurance_record_counters_last_no_check
             check (last_no between 1 and 9999)
);

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
      if not coalesce(p_top_up, false) then
        return jsonb_build_object(
          'outcome', 'cap_reached',
          'season_key', v_season,
          'list_cents', v_list,
          'owed_cents', v_owed,
          'top_up_cents', c_cap - v_owed
        );
      end if;
      v_amount := c_cap - v_owed;
      v_coverage := 'cap_top_up';
      v_status := 'unpaid';
    else
      v_amount := v_list;
      v_coverage := 'per_lesson';
      v_status := 'unpaid';
    end if;
  else
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

alter table lesson_insurance_records enable row level security;
alter table lesson_insurance_records force row level security;
revoke all on lesson_insurance_records from public, anon, authenticated;

alter table lesson_insurance_record_counters enable row level security;
alter table lesson_insurance_record_counters force row level security;
revoke all on lesson_insurance_record_counters from public, anon, authenticated;
