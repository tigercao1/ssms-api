create table if not exists lesson_insurance_requests (
  id                  uuid primary key default gen_random_uuid(),
  instructor_id       uuid not null
                        constraint lesson_insurance_requests_instructor_id_fkey
                        references instructors (id),
  season_key          text not null references seasons (key) on update cascade,
  request_no          text not null
                        constraint lesson_insurance_requests_request_no_key unique
                        constraint lesson_insurance_requests_request_no_check
                        check (request_no ~ '^INS-\d{8}-\d{4}$'),
  payment_status      text not null
                        constraint lesson_insurance_requests_payment_status_check
                        check (payment_status in ('unpaid', 'paid', 'not_required', 'voided')),
  total_cents         int not null
                        constraint lesson_insurance_requests_total_cents_check
                        check (total_cents between 0 and 40000),
  lesson_count        int not null
                        constraint lesson_insurance_requests_lesson_count_check
                        check (lesson_count between 1 and 10),
  paid_on             date,
  paid_note           text
                        constraint lesson_insurance_requests_paid_note_check
                        check (char_length(paid_note) <= 500),
  paid_by             uuid,
  voided_at           timestamptz,
  voided_reason       text
                        constraint lesson_insurance_requests_voided_reason_check
                        check (char_length(voided_reason) between 1 and 500),
  voided_by           uuid,
  voided_from_status  text
                        constraint lesson_insurance_requests_voided_from_status_check
                        check (voided_from_status in ('unpaid', 'paid', 'not_required')),
  idempotency_key     uuid not null,
  created_by          uuid,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint lesson_insurance_requests_idempotency_key
    unique (instructor_id, idempotency_key),
  constraint lesson_insurance_requests_total_status_check
    check (
      case payment_status
        when 'not_required' then total_cents = 0
        when 'voided' then (voided_from_status = 'not_required') = (total_cents = 0)
        else total_cents > 0
      end
    ),
  constraint lesson_insurance_requests_paid_check
    check (
      (payment_status = 'paid'
        or (payment_status = 'voided' and voided_from_status is not distinct from 'paid'))
      = (paid_on is not null)
      and (paid_on is not null or (paid_note is null and paid_by is null))
    ),
  constraint lesson_insurance_requests_voided_check
    check ((payment_status = 'voided') = (
      voided_at is not null and voided_reason is not null and voided_from_status is not null
    ))
);

create index if not exists lesson_insurance_requests_instructor_season_idx
  on lesson_insurance_requests (instructor_id, season_key);
create index if not exists lesson_insurance_requests_season_status_idx
  on lesson_insurance_requests (season_key, payment_status);

create or replace trigger lesson_insurance_requests_set_updated_at
  before update on lesson_insurance_requests
  for each row execute function public.set_updated_at();

alter table lesson_insurance_requests enable row level security;
alter table lesson_insurance_requests force row level security;
revoke all on lesson_insurance_requests from public, anon, authenticated;

alter table lesson_insurance_records
  add column if not exists request_id uuid
    constraint lesson_insurance_records_request_id_fkey
    references lesson_insurance_requests (id);

alter table lesson_insurance_records
  add constraint lesson_insurance_records_request_kind_check
  check (request_id is null or kind = 'lesson');

create index if not exists lesson_insurance_records_request_idx
  on lesson_insurance_records (request_id)
  where request_id is not null;

create or replace function public.lesson_insurance_submit_request(
  p_instructor_id uuid,
  p_season_key text,
  p_lessons jsonb,
  p_idempotency_key uuid,
  p_actor uuid
) returns jsonb
language plpgsql
set search_path = public
as $$
declare
  c_max_lessons constant int := 10;
  v_existing uuid;
  v_count int;
  v_index int;
  v_lesson jsonb;
  v_season text;
  v_lesson_season text;
  v_day date;
  v_no int;
  v_request uuid;
  v_result jsonb;
  v_total int;
begin
  if p_idempotency_key is null then
    raise exception 'an insurance request needs an idempotency key' using errcode = '22023';
  end if;

  select id into v_existing from lesson_insurance_requests
   where instructor_id = p_instructor_id and idempotency_key = p_idempotency_key;
  if found then
    return jsonb_build_object('outcome', 'existing', 'id', v_existing);
  end if;

  if jsonb_typeof(p_lessons) is distinct from 'array' or jsonb_array_length(p_lessons) = 0 then
    raise exception 'an insurance request needs at least one lesson' using errcode = '22023';
  end if;
  v_count := jsonb_array_length(p_lessons);
  if v_count > c_max_lessons then
    return jsonb_build_object('outcome', 'too_many_lessons', 'lesson_count', v_count);
  end if;

  if p_season_key is not null then
    select key into v_season from seasons where key = p_season_key;
    if v_season is null then
      return jsonb_build_object('outcome', 'no_season');
    end if;
  end if;

  for v_index in 0 .. v_count - 1 loop
    v_lesson := p_lessons -> v_index;
    v_lesson_season := null;
    select key into v_lesson_season from seasons
     where (v_lesson ->> 'lessonDate')::date between starts_on and ends_on;
    if v_lesson_season is null then
      return jsonb_build_object('outcome', 'no_season', 'lesson_index', v_index);
    end if;
    if v_season is null then
      v_season := v_lesson_season;
    elsif v_lesson_season <> v_season then
      return jsonb_build_object(
        'outcome', 'mixed_seasons',
        'lesson_index', v_index,
        'season_key', v_season
      );
    end if;
  end loop;

  perform pg_advisory_xact_lock(
    hashtext('lesson_insurance'),
    hashtext(p_instructor_id::text || '|' || v_season)
  );

  select id into v_existing from lesson_insurance_requests
   where instructor_id = p_instructor_id and idempotency_key = p_idempotency_key;
  if found then
    return jsonb_build_object('outcome', 'existing', 'id', v_existing);
  end if;

  v_day := (now() at time zone 'America/Toronto')::date;
  insert into lesson_insurance_record_counters as c (day, last_no)
  values (v_day, 1)
  on conflict (day) do update set last_no = c.last_no + 1
  returning last_no into v_no;

  insert into lesson_insurance_requests (
    instructor_id, season_key, request_no, payment_status, total_cents,
    lesson_count, idempotency_key, created_by
  ) values (
    p_instructor_id, v_season,
    'INS-' || to_char(v_day, 'YYYYMMDD') || '-' || lpad(v_no::text, 4, '0'),
    'not_required', 0, v_count, p_idempotency_key, p_actor
  )
  returning id into v_request;

  for v_index in 0 .. v_count - 1 loop
    v_lesson := p_lessons -> v_index;
    v_result := public.lesson_insurance_register(
      p_instructor_id, 'lesson', null,
      (v_lesson ->> 'lessonDate')::date,
      (v_lesson ->> 'durationHours')::int,
      (v_lesson ->> 'locationId')::uuid,
      v_lesson ->> 'locationOther',
      v_lesson -> 'students',
      false, null, p_actor
    );
    if v_result ->> 'outcome' is distinct from 'created' then
      raise exception 'lesson % of an insurance request was not created: %', v_index, v_result;
    end if;
    update lesson_insurance_records
       set request_id = v_request
     where id = (v_result ->> 'id')::uuid;
  end loop;

  select coalesce(sum(amount_cents), 0)::int into v_total
    from lesson_insurance_records
   where request_id = v_request;

  update lesson_insurance_requests
     set total_cents = v_total,
         payment_status = case when v_total > 0 then 'unpaid' else 'not_required' end
   where id = v_request;

  return jsonb_build_object('outcome', 'created', 'id', v_request);
end;
$$;

revoke all on function public.lesson_insurance_submit_request(uuid, text, jsonb, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.lesson_insurance_submit_request(uuid, text, jsonb, uuid, uuid)
  to service_role;

create or replace function public.lesson_insurance_request_transition(
  p_request_id uuid,
  p_action text,
  p_actor uuid,
  p_paid_on date,
  p_note text,
  p_reason text
) returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_from text;
begin
  if p_action not in ('mark_paid', 'mark_unpaid', 'void') then
    raise exception 'unknown insurance request action %', p_action using errcode = '22023';
  end if;

  select payment_status into v_from from lesson_insurance_requests
   where id = p_request_id
   for update;
  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  if p_action = 'mark_paid' then
    if v_from <> 'unpaid' then
      return jsonb_build_object('outcome', 'conflict', 'from', v_from);
    end if;
    update lesson_insurance_requests
       set payment_status = 'paid', paid_on = p_paid_on, paid_note = p_note, paid_by = p_actor
     where id = p_request_id;
    update lesson_insurance_records
       set payment_status = 'paid', paid_on = p_paid_on, paid_note = p_note, paid_by = p_actor
     where request_id = p_request_id and payment_status = 'unpaid';
  elsif p_action = 'mark_unpaid' then
    if v_from <> 'paid' then
      return jsonb_build_object('outcome', 'conflict', 'from', v_from);
    end if;
    update lesson_insurance_requests
       set payment_status = 'unpaid', paid_on = null, paid_note = null, paid_by = null
     where id = p_request_id;
    update lesson_insurance_records
       set payment_status = 'unpaid', paid_on = null, paid_note = null, paid_by = null
     where request_id = p_request_id and payment_status = 'paid';
  else
    if v_from = 'voided' then
      return jsonb_build_object('outcome', 'conflict', 'from', v_from);
    end if;
    update lesson_insurance_requests
       set payment_status = 'voided', voided_at = now(), voided_reason = p_reason,
           voided_by = p_actor, voided_from_status = payment_status
     where id = p_request_id;
    update lesson_insurance_records
       set payment_status = 'voided', voided_at = now(), voided_reason = p_reason,
           voided_by = p_actor, voided_from_status = payment_status
     where request_id = p_request_id and payment_status <> 'voided';
  end if;

  return jsonb_build_object('outcome', 'updated', 'from', v_from);
end;
$$;

revoke all on function public.lesson_insurance_request_transition(uuid, text, uuid, date, text, text)
  from public, anon, authenticated;
grant execute on function public.lesson_insurance_request_transition(uuid, text, uuid, date, text, text)
  to service_role;
