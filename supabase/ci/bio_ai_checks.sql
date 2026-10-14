\set ON_ERROR_STOP on
begin;

insert into auth.users (id, email)
values ('11111111-1111-4111-8111-111111111191', 'ci-bio-ai@example.com');
insert into instructors (id, auth_user_id, email, bio_zh, bio_zh_machine_translated, bio_zh_translated_by)
values ('22222222-2222-4222-8222-222222222191', '11111111-1111-4111-8111-111111111191',
        'ci-bio-ai@example.com', '机器', true, 'old-model');

do $$
declare
  inst constant uuid := '22222222-2222-4222-8222-222222222191';
  r record;
  first_id uuid;
begin
  if (select bio_en_updated_at from instructors where id = inst) is not null then
    raise exception 'bio_en_updated_at set without an English bio';
  end if;
  if (select bio_zh_updated_at from instructors where id = inst) is null then
    raise exception 'bio_zh_updated_at not set on insert';
  end if;
  update instructors set bio_zh_updated_at = null where id = inst;

  -- Existing callers: a bio write still clears the machine-translated flag.
  perform public.update_instructor_profile(inst, '{"bio_en": "Hello"}'::jsonb);
  select * into r from instructors where id = inst;
  if r.bio_en_machine_translated or r.bio_en_updated_at is null then
    raise exception 'bio_en write without flags misbehaved';
  end if;
  if r.bio_zh_updated_at is not null or not r.bio_zh_machine_translated
     or r.bio_zh_translated_by <> 'old-model' then
    raise exception 'untouched bio_zh changed';
  end if;

  perform public.update_instructor_profile(inst, '{"bio_zh": "人写的"}'::jsonb);
  select * into r from instructors where id = inst;
  if r.bio_zh_machine_translated or r.bio_zh_translated_by is not null then
    raise exception 'bio_zh write without flags kept the machine translation';
  end if;

  -- New keys: both bios in one call, zh marked machine-translated.
  perform public.update_instructor_profile(inst,
    '{"bio_en": "Hi", "bio_zh": "你好", "bio_en_machine_translated": false,
      "bio_zh_machine_translated": true, "bio_zh_translated_by": "gemini-test"}'::jsonb);
  select * into r from instructors where id = inst;
  if r.bio_en_machine_translated or not r.bio_zh_machine_translated
     or r.bio_zh_translated_by <> 'gemini-test' or r.bio_en_translated_by is not null then
    raise exception 'machine-translated keys not applied';
  end if;
  if r.bio_en_updated_at is distinct from r.bio_zh_updated_at then
    raise exception 'bios saved together have different timestamps';
  end if;

  perform public.update_instructor_profile(inst, '{"display_name_en": "X"}'::jsonb);
  select * into r from instructors where id = inst;
  if not r.bio_zh_machine_translated or r.bio_zh_translated_by <> 'gemini-test' then
    raise exception 'a non-bio patch changed the machine-translated state';
  end if;

  -- Timestamps. now() is fixed in this transaction, so start from old values.
  update instructors set bio_en = 'Src', bio_zh = '旧',
         bio_en_updated_at = '2020-01-01', bio_zh_updated_at = '2020-01-02'
   where id = inst;
  select * into r from instructors where id = inst;
  if r.bio_en_updated_at <> '2020-01-01' or r.bio_zh_updated_at <> '2020-01-02' then
    raise exception 'explicit timestamps were overwritten by the trigger';
  end if;

  -- bio_synced: both sides stamped together, unchanged text included.
  perform public.update_instructor_profile(inst,
    '{"bio_zh": "新译文", "bio_synced": true}'::jsonb);
  select * into r from instructors where id = inst;
  if r.bio_en_updated_at <> now() or r.bio_zh_updated_at <> now() then
    raise exception 'bio_synced did not stamp both sides: % / %',
      r.bio_en_updated_at, r.bio_zh_updated_at;
  end if;
  update instructors set bio_en_updated_at = '2020-01-01',
         bio_zh_updated_at = '2020-01-02' where id = inst;
  perform public.update_instructor_profile(inst, '{"bio_synced": true}'::jsonb);
  select * into r from instructors where id = inst;
  if r.bio_en_updated_at <> now() or r.bio_zh_updated_at <> now()
     or r.bio_en <> 'Src' or r.bio_zh <> '新译文' then
    raise exception 'bio_synced with both texts unchanged misbehaved';
  end if;

  -- One bio key, no bio_synced: only the changed side is stamped.
  update instructors set bio_en_updated_at = '2020-01-01',
         bio_zh_updated_at = '2020-01-02' where id = inst;
  perform public.update_instructor_profile(inst, '{"bio_zh": "单边"}'::jsonb);
  select * into r from instructors where id = inst;
  if r.bio_zh_updated_at <> now() or r.bio_en_updated_at <> '2020-01-01' then
    raise exception 'single-key save stamped the wrong side';
  end if;
  update instructors set bio_zh_updated_at = '2020-01-02' where id = inst;
  perform public.update_instructor_profile(inst,
    '{"bio_en": "Src", "bio_synced": false}'::jsonb);
  perform public.update_instructor_profile(inst, '{"display_name_en": "Y"}'::jsonb);
  select * into r from instructors where id = inst;
  if r.bio_en_updated_at <> '2020-01-01' or r.bio_zh_updated_at <> '2020-01-02' then
    raise exception 'unchanged or non-bio save moved a timestamp';
  end if;

  -- Worker-style write: an explicit target timestamp wins over the trigger.
  update instructors set bio_zh = '机器译文', bio_zh_machine_translated = true,
         bio_zh_updated_at = bio_en_updated_at
   where id = inst;
  select * into r from instructors where id = inst;
  if r.bio_zh_updated_at is distinct from r.bio_en_updated_at then
    raise exception 'worker target timestamp not kept equal to the source';
  end if;
  update instructors set bio_en_updated_at = null where id = inst;
  update instructors set bio_zh = '机器译文二', bio_zh_updated_at = null
   where id = inst;
  select * into r from instructors where id = inst;
  if r.bio_zh_updated_at is not null then
    raise exception 'explicit null target timestamp was stamped';
  end if;
  update instructors set bio_en = 'Plain' where id = inst;
  if (select bio_en_updated_at from instructors where id = inst) <> now() then
    raise exception 'text change without an explicit timestamp not stamped';
  end if;

  -- Quota: five reservations, the sixth is refused.
  for i in 1..5 loop
    select * into r from public.reserve_bio_ai_request(inst, 'refine', 5);
    if r.request_id is null or r.used <> i then
      raise exception 'reservation % failed: %', i, r;
    end if;
    if i = 1 then
      first_id := r.request_id;
    end if;
  end loop;
  select * into r from public.reserve_bio_ai_request(inst, 'translate', 5);
  if r.request_id is not null or r.used <> 5 or r.oldest_at is null then
    raise exception 'sixth reservation was not refused: %', r;
  end if;

  delete from bio_ai_requests where id = first_id;
  select * into r from public.reserve_bio_ai_request(inst, 'translate', 5);
  if r.request_id is null or r.used <> 5 then
    raise exception 'released slot was not reusable: %', r;
  end if;

  update bio_ai_requests set created_at = now() - interval '25 hours'
   where instructor_id = inst;
  select * into r from public.bio_ai_usage(inst);
  if r.used <> 0 or r.oldest_at is not null then
    raise exception 'requests older than 24 h still counted: %', r;
  end if;

  if not exists (
    select 1 from pg_class
     where relname = 'bio_ai_requests' and relrowsecurity and relforcerowsecurity
  ) then
    raise exception 'bio_ai_requests RLS is not enabled and forced';
  end if;
  if has_table_privilege('anon', 'bio_ai_requests', 'select')
     or has_table_privilege('authenticated', 'bio_ai_requests', 'select') then
    raise exception 'bio_ai_requests is readable by anon/authenticated';
  end if;
  if has_function_privilege('authenticated', 'public.reserve_bio_ai_request(uuid, text, int)', 'execute') then
    raise exception 'authenticated can reserve bio AI requests';
  end if;
end
$$;

rollback;
\echo 'Bio AI checks passed.'
