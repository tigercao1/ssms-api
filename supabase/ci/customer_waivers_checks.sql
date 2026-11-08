\set ON_ERROR_STOP on
begin;

insert into customers (id, shopify_customer_id, first_name, last_name, email, created_at) values
  ('77777777-7777-4777-8777-777777777801', null, 'Mia', 'Waiver', 'mia@example.com', '2026-10-01Z'),
  ('77777777-7777-4777-8777-777777777802', 4802, 'Mia', 'Shopify', 'Mia@Example.com', '2026-10-02Z'),
  ('77777777-7777-4777-8777-777777777803', 4803, 'Sam', 'Lee', 'sam@example.com', '2026-10-01Z');

do $$
declare
  v_new uuid;
begin
  if waiver_customer_for_email(' MIA@example.com ', 'Leo', 'Chen') <> '77777777-7777-4777-8777-777777777802' then
    raise exception 'an email match did not prefer the Shopify customer';
  end if;
  v_new := waiver_customer_for_email('new@example.com', 'Sam', 'Lee');
  if v_new in ('77777777-7777-4777-8777-777777777803') then
    raise exception 'a signer was matched by name';
  end if;
  if (select email || first_name || last_name || coalesce(shopify_customer_id::text, '-')
        from customers where id = v_new) <> 'new@example.comSamLee-' then
    raise exception 'a new waiver customer was not created with the lower-cased email';
  end if;
  if waiver_customer_for_email('NEW@example.com', 'Other', null) <> v_new then
    raise exception 'a second signature with the same email created another customer';
  end if;
  begin
    perform waiver_customer_for_email('  ', 'X', null);
    raise exception 'a blank email was accepted';
  exception when null_value_not_allowed then null;
  end;
end
$$;

do $$
begin
  perform reconcile_customer_deletions(array[4802, 4803]::bigint[], now());
  if exists (select 1 from customers where shopify_customer_id is null and shopify_deleted_at is not null) then
    raise exception 'reconcile marked a waiver-only customer deleted in Shopify';
  end if;
end
$$;

insert into document_templates (id, kind, audience, title_en, slug) values
  ('33333333-3333-4333-8333-333333333801', 'form', 'customer', 'CI waiver', 'ci-waiver');

do $$
begin
  begin
    insert into document_templates (kind, audience, title_en) values ('form', 'customer', 'No slug');
    raise exception 'a form without a slug was accepted';
  exception when check_violation then null;
  end;
  begin
    insert into document_templates (kind, audience, title_en, slug) values ('form', 'customer', 'Dup', 'ci-waiver');
    raise exception 'a duplicate slug was accepted';
  exception when unique_violation then null;
  end;
  begin
    insert into document_templates (kind, audience, title_en, slug) values ('form', 'customer', 'Bad', 'Bad Slug');
    raise exception 'a malformed slug was accepted';
  exception when check_violation then null;
  end;
end
$$;

insert into document_form_versions (template_id, language, version, title, body_markdown, body_sha256)
values ('33333333-3333-4333-8333-333333333801', 'en', 1, 'Waiver', 'Text', repeat('a', 64));

do $$
begin
  insert into document_form_versions (template_id, language, version, title, body_markdown, body_sha256)
  values ('33333333-3333-4333-8333-333333333801', 'en', 2, 'Waiver', 'Text 2', repeat('b', 64));
  raise exception 'a second draft for one language was accepted';
exception when unique_violation then null;
end
$$;

insert into document_assignments (template_id, subject_type, subject_id, status, form_version, completed_at) values
  ('33333333-3333-4333-8333-333333333801', 'customer', '77777777-7777-4777-8777-777777777802', 'completed', 1, '2026-11-01Z'),
  ('33333333-3333-4333-8333-333333333801', 'customer', '77777777-7777-4777-8777-777777777802', 'completed', 1, '2026-11-02Z');

insert into auth.users (id, email) values ('11111111-1111-4111-8111-111111111801', 'ci-waiver@example.com');
insert into instructors (id, auth_user_id, email, approval_status, is_active) values
  ('22222222-2222-4222-8222-222222222801', '11111111-1111-4111-8111-111111111801',
   'ci-waiver@example.com', 'approved', true);
insert into document_templates (id, kind, audience, title_en) values
  ('33333333-3333-4333-8333-333333333802', 'read', 'instructor', 'CI read');
insert into document_assignments (template_id, subject_type, subject_id, season) values
  ('33333333-3333-4333-8333-333333333802', 'instructor', '22222222-2222-4222-8222-222222222801', '2026/27');

do $$
begin
  insert into document_assignments (template_id, subject_type, subject_id, season) values
    ('33333333-3333-4333-8333-333333333802', 'instructor', '22222222-2222-4222-8222-222222222801', '2026/27');
  raise exception 'a duplicate open instructor assignment was accepted';
exception when unique_violation then null;
end
$$;

do $$
declare
  v_mia text := repeat('a', 64);
  v_leo text := repeat('b', 64);
  i int;
begin
  for i in 1..3 loop
    if not claim_form_copy_email(v_mia, 3, 3600, 5, 60) then
      raise exception 'copy email % to one address was refused under the limit', i;
    end if;
  end loop;
  if claim_form_copy_email(v_mia, 3, 3600, 5, 60) then
    raise exception 'a 4th copy email to one address in an hour was allowed';
  end if;
  if not claim_form_copy_email(v_leo, 3, 3600, 5, 60) then
    raise exception 'one address''s limit blocked another address';
  end if;
  if not claim_form_copy_email(repeat('c', 64), 3, 3600, 5, 60) then
    raise exception 'the 5th copy email in a minute was refused';
  end if;
  if claim_form_copy_email(repeat('d', 64), 3, 3600, 5, 60) then
    raise exception 'a 6th copy email in a minute was allowed past the global limit';
  end if;

  update form_copy_email_claims set claimed_at = now() - interval '61 seconds';
  if not claim_form_copy_email(repeat('d', 64), 3, 3600, 5, 60) then
    raise exception 'the global limit did not reopen after its window';
  end if;
  if claim_form_copy_email(v_mia, 3, 3600, 5, 60) then
    raise exception 'the per-address limit reopened before its hour';
  end if;

  update form_copy_email_claims set claimed_at = now() - interval '3601 seconds';
  if not claim_form_copy_email(v_mia, 3, 3600, 5, 60) then
    raise exception 'the per-address limit did not reopen after an hour';
  end if;
  if (select count(*) from form_copy_email_claims) <> 1 then
    raise exception 'claims older than the windows were not cleaned up';
  end if;
end
$$;

insert into auth.users (id, email) values ('11111111-1111-4111-8111-111111111802', 'ci-other@example.com');
insert into instructors (id, auth_user_id, email, approval_status, is_active) values
  ('22222222-2222-4222-8222-222222222802', '11111111-1111-4111-8111-111111111802',
   'ci-other@example.com', 'approved', true);
insert into customers (id, shopify_customer_id, first_name, last_name, email) values
  ('77777777-7777-4777-8777-777777777804', 4804, 'Ada', 'Wu', 'ada@example.com');
insert into classes (id, instructor_id, starts_at, ends_at, status) values
  ('44444444-4444-4444-8444-444444444801', '22222222-2222-4222-8222-222222222801', '2026-12-01 10:00Z', '2026-12-01 12:00Z', 'scheduled'),
  ('44444444-4444-4444-8444-444444444802', '22222222-2222-4222-8222-222222222801', '2026-12-02 10:00Z', '2026-12-02 12:00Z', 'cancelled'),
  ('44444444-4444-4444-8444-444444444803', '22222222-2222-4222-8222-222222222802', '2026-12-03 10:00Z', '2026-12-03 12:00Z', 'scheduled');
insert into class_participants (class_id, customer_id) values
  ('44444444-4444-4444-8444-444444444801', '77777777-7777-4777-8777-777777777802'),
  ('44444444-4444-4444-8444-444444444802', '77777777-7777-4777-8777-777777777803'),
  ('44444444-4444-4444-8444-444444444803', '77777777-7777-4777-8777-777777777804'),
  ('44444444-4444-4444-8444-444444444803', '77777777-7777-4777-8777-777777777802');

do $$
begin
  if (select array_agg(name || ':' || coalesce((signed_at at time zone 'UTC')::date::text, '-'))
        from instructor_student_signatures('22222222-2222-4222-8222-222222222801', '', 100))
     <> array['Mia Shopify:2026-11-02'] then
    raise exception 'an instructor saw students outside their own live classes, or the wrong signing date';
  end if;
  if (select array_agg(name || ':' || coalesce((signed_at at time zone 'UTC')::date::text, '-') order by name)
        from instructor_student_signatures('22222222-2222-4222-8222-222222222802', null, 100))
     <> array['Ada Wu:-', 'Mia Shopify:2026-11-02'] then
    raise exception 'the other instructor''s students were wrong';
  end if;
  if exists (select 1 from instructor_student_signatures('22222222-2222-4222-8222-222222222802', 'MIA@EXAMPLE', 100)
              where name = 'Ada Wu') then
    raise exception 'the student search did not filter';
  end if;
end
$$;

do $$
begin
  if (select count(*) from admin_signature_lookup('mia', 10)
       where subject_id = '77777777-7777-4777-8777-777777777802' and assignment_id is not null) <> 2 then
    raise exception 'the admin lookup did not list both signatures of a customer';
  end if;
  if not exists (select 1 from admin_signature_lookup('MIA', 10)
                  where subject_id = '77777777-7777-4777-8777-777777777801' and assignment_id is null) then
    raise exception 'the admin lookup left out a customer who signed nothing';
  end if;
  if (select array_agg(distinct subject_type) from admin_signature_lookup('ci-waiver@', 10))
     <> array['instructor'] then
    raise exception 'the admin lookup did not find an instructor by email';
  end if;
end
$$;

do $$
declare
  v_waiver uuid := waiver_customer_for_email('prepurchase@example.com', 'Prepurchase', 'Signer');
  v_shopify uuid;
begin
  insert into document_assignments (template_id, subject_type, subject_id, status, form_version, completed_at)
  values ('33333333-3333-4333-8333-333333333801', 'customer', v_waiver, 'completed', 1, '2026-11-03Z');
  perform upsert_customer_if_newer(4805, 'Prepurchase', 'Signer', 'PrePurchase@example.com', null, now());
  select id into v_shopify from customers where shopify_customer_id = 4805;
  if v_shopify = v_waiver then
    raise exception 'the probe expected Shopify to create a second customer row';
  end if;
  insert into class_participants (class_id, customer_id)
  values ('44444444-4444-4444-8444-444444444803', v_shopify);

  if (select array_agg(coalesce((signed_at at time zone 'UTC')::date::text, '-'))
        from instructor_student_signatures('22222222-2222-4222-8222-222222222802', 'prepurchase', 100))
     <> array['2026-11-03'] then
    raise exception 'a waiver signed before Shopify created the same-email customer was not shown as signed';
  end if;
end
$$;

set local role anon;
do $$
begin
  perform 1 from document_form_versions;
  raise exception 'anon could read document_form_versions';
exception when insufficient_privilege then null;
end
$$;
do $$
begin
  perform waiver_customer_for_email('x@example.com', null, null);
  raise exception 'anon could call waiver_customer_for_email';
exception when insufficient_privilege then null;
end
$$;
do $$
begin
  perform claim_form_copy_email(repeat('a', 64), 3, 3600, 5, 60);
  raise exception 'anon could call claim_form_copy_email';
exception when insufficient_privilege then null;
end
$$;
do $$
begin
  perform admin_signature_lookup('mia', 10);
  raise exception 'anon could call admin_signature_lookup';
exception when insufficient_privilege then null;
end
$$;
reset role;

rollback;
\echo 'Customer waiver checks passed.'
