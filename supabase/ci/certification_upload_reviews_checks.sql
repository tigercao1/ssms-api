\set ON_ERROR_STOP on
begin;

insert into auth.users (id, email)
select ('11111111-1111-4111-8111-' || lpad(n::text, 12, '0'))::uuid,
       'ci-review-' || n || '@example.com'
from generate_series(1, 401) as n;
insert into instructors (id, auth_user_id, email, first_name, last_name, display_name_en)
select ('22222222-2222-4222-8222-' || lpad(n::text, 12, '0'))::uuid,
       ('11111111-1111-4111-8111-' || lpad(n::text, 12, '0'))::uuid,
       'ci-review-' || n || '@example.com', 'First' || n, 'Last' || n, 'Coach ' || n
from generate_series(1, 401) as n;

insert into instructor_certifications (instructor_id, org, track, level) values
  ('22222222-2222-4222-8222-000000000001', 'csia', 'regular', 3);

insert into certification_uploads
  (instructor_id, org, track, file_key, sha256, content_type, size_bytes,
   review_status, reviewed_at, valid_until, inserted_at)
select ('22222222-2222-4222-8222-' || lpad(n::text, 12, '0'))::uuid,
       k.org, k.track, 'subjects/instructor/x/certifications/y.pdf', repeat('a', 64),
       'application/pdf', 1000, v.review_status, v.reviewed_at, '2027-10-31',
       '2026-01-01T00:00:00Z'::timestamptz
         + make_interval(mins => v.minute_base + n * 3 + k.ord)
from generate_series(1, 400) as n
cross join (values (0, 'csia', 'regular'), (1, 'csia', 'park'), (2, 'casi', 'regular'))
  as k(ord, org, track)
cross join (values
  ('pending', null::timestamptz, 0),
  ('pending', null::timestamptz, 10000)
) as v(review_status, reviewed_at, minute_base);

insert into certification_uploads
  (id, instructor_id, org, track, file_key, sha256, content_type, size_bytes,
   review_status, reviewed_at, valid_until, inserted_at)
select ('33333333-3333-4333-8333-' || lpad(n::text, 12, '0'))::uuid,
       ('22222222-2222-4222-8222-' || lpad((((n - 1) % 400) + 1)::text, 12, '0'))::uuid,
       'casi', 'carving', 'subjects/instructor/x/certifications/y.pdf', repeat('a', 64),
       'application/pdf', 1000, case when n % 2 = 0 then 'approved' else 'rejected' end,
       '2026-10-01T00:00:00Z'::timestamptz + make_interval(mins => n / 2),
       '2027-10-31', '2026-01-01T00:00:00Z'::timestamptz + make_interval(mins => n)
from generate_series(1, 1100) as n;

update certification_uploads
   set reviewed_at = '2026-09-01T00:00:00Z'
 where id in ('33333333-3333-4333-8333-000000001098', '33333333-3333-4333-8333-000000001099',
              '33333333-3333-4333-8333-000000001100');

insert into certification_uploads
  (id, instructor_id, org, track, file_key, sha256, content_type, size_bytes,
   review_status, valid_until, inserted_at)
values
  ('44444444-4444-4444-8444-000000000001', '22222222-2222-4222-8222-000000000401',
   'csia', 'carving', 'k', repeat('a', 64), 'image/png', 1, 'pending', '2027-10-31',
   '2025-12-31T00:00:00Z'),
  ('44444444-4444-4444-8444-000000000002', '22222222-2222-4222-8222-000000000401',
   'csia', 'carving', 'k', repeat('a', 64), 'image/png', 1, 'pending', '2027-10-31',
   '2025-12-31T00:00:00Z');

do $$
declare
  v_ids uuid[];
  v_expected uuid[];
  v_total int;
  v_page_total int;
  v_count int;
  v_page int;
  v_row record;
begin
  select array_agg(id order by inserted_at, id) into v_expected
  from (
    select u.id, u.inserted_at, u.review_status,
           row_number() over (
             partition by u.instructor_id, u.org, u.track
             order by u.inserted_at desc, u.id desc
           ) as rank
    from certification_uploads u
  ) latest
  where rank = 1 and review_status = 'pending';

  if cardinality(v_expected) <> 1201 then
    raise exception 'fixture wrong: % current pending', cardinality(v_expected);
  end if;

  select array_agg(id order by ord), max(total_count) into v_ids, v_total
  from (
    select id, total_count, row_number() over () as ord
    from public.certification_upload_reviews('pending', null, 5000, 0)
  ) t;
  if v_total <> 1201 or v_ids <> v_expected then
    raise exception 'pending current selection or order wrong (total %)', v_total;
  end if;
  if v_ids[1] <> '44444444-4444-4444-8444-000000000002' then
    raise exception 'equal inserted_at not tie-broken by id: %', v_ids[1];
  end if;

  v_ids := '{}';
  for v_page in 0..12 loop
    select coalesce(array_agg(id order by ord), '{}'), coalesce(max(total_count), 0)
      into v_expected, v_page_total
    from (
      select id, total_count, row_number() over () as ord
      from public.certification_upload_reviews('pending', null, 100, v_page * 100)
    ) t;
    if cardinality(v_expected) > 0 and v_page_total <> 1201 then
      raise exception 'page % total wrong: %', v_page + 1, v_page_total;
    end if;
    v_ids := v_ids || v_expected;
  end loop;
  select array_agg(id order by ord) into v_expected
  from (
    select id, row_number() over () as ord
    from public.certification_upload_reviews('pending', null, 5000, 0)
  ) t;
  if v_ids <> v_expected then
    raise exception 'pages of 100 do not add up to the full pending queue';
  end if;

  select count(*) into v_count
  from public.certification_upload_reviews('pending', null, 100, 1300);
  if v_count <> 0 then
    raise exception 'offset past the end returned % rows', v_count;
  end if;

  select * into v_row
  from public.certification_upload_reviews('pending', null, 100, 1)
  where instructor_id = '22222222-2222-4222-8222-000000000001'
    and org = 'csia' and track = 'regular';
  if v_row.level is distinct from 3 or not v_row.is_current
     or v_row.instructor_email <> 'ci-review-1@example.com'
     or v_row.instructor_first_name <> 'First1'
     or v_row.instructor_display_name_en <> 'Coach 1' then
    raise exception 'pending row columns wrong: %', v_row;
  end if;

  select array_agg(id order by ord), max(total_count) into v_ids, v_total
  from (
    select id, total_count, row_number() over () as ord
    from public.certification_upload_reviews('decided', '2026-09-15T00:00:00Z', 5000, 0)
  ) t;
  select array_agg(id order by reviewed_at desc, id) into v_expected
  from certification_uploads
  where review_status in ('approved', 'rejected')
    and reviewed_at >= '2026-09-15T00:00:00Z';
  if v_total <> 1097 or v_ids <> v_expected then
    raise exception 'decided window or order wrong (total %)', v_total;
  end if;
  if v_ids[1:2] <> array[
    '33333333-3333-4333-8333-000000001096', '33333333-3333-4333-8333-000000001097'
  ]::uuid[] then
    raise exception 'equal reviewed_at not tie-broken by id: %', v_ids[1:2];
  end if;

  select count(*) filter (where is_current), count(*) into v_count, v_total
  from public.certification_upload_reviews('decided', '2026-09-15T00:00:00Z', 5000, 0);
  if v_count <> 397 or v_total <> 1097 then
    raise exception 'decided is_current wrong: % of %', v_count, v_total;
  end if;

  select array_agg(id order by ord), max(total_count) into v_ids, v_total
  from (
    select id, total_count, row_number() over () as ord
    from public.certification_upload_reviews('decided', '2026-09-15T00:00:00Z', 2, 1000)
  ) t;
  select array_agg(id order by reviewed_at desc, id) into v_expected
  from (
    select id, reviewed_at from certification_uploads
    where review_status in ('approved', 'rejected')
      and reviewed_at >= '2026-09-15T00:00:00Z'
    order by reviewed_at desc, id
    limit 2 offset 1000
  ) t;
  if v_total <> 1097 or v_ids <> v_expected then
    raise exception 'decided paging past 1000 wrong: % (total %)', v_ids, v_total;
  end if;

  select count(*) into v_count
  from public.certification_upload_reviews('all', '2026-01-01T00:00:00Z', 100, 0);
  if v_count <> 0 then
    raise exception 'unknown status returned % rows', v_count;
  end if;

  if has_function_privilege('authenticated',
       'public.certification_upload_reviews(text, timestamptz, int, int)', 'execute')
     or has_function_privilege('anon',
       'public.certification_upload_reviews(text, timestamptz, int, int)', 'execute') then
    raise exception 'certification_upload_reviews is executable by client roles';
  end if;
  if not has_function_privilege('service_role',
       'public.certification_upload_reviews(text, timestamptz, int, int)', 'execute') then
    raise exception 'certification_upload_reviews is not executable by service_role';
  end if;
end;
$$;

rollback;
\echo 'Certification upload reviews checks passed.'
