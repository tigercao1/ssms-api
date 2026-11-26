\set ON_ERROR_STOP on
begin;

insert into customers (id, shopify_customer_id, first_name, last_name, email) values
  ('77777777-7777-4777-8777-777777777a01', null, 'Ana', 'Lee', 'ana@example.com'),
  ('77777777-7777-4777-8777-777777777a02', 49002, 'Ana', 'Shopify', 'ANA@example.com'),
  ('77777777-7777-4777-8777-777777777a03', null, 'Bo', 'Kim', 'bo@example.com'),
  ('77777777-7777-4777-8777-777777777a04', null, 'Cy', 'Ng', null),
  ('77777777-7777-4777-8777-777777777a05', null, 'Di', 'Ho', 'di@example.com'),
  ('77777777-7777-4777-8777-777777777a06', null, 'Ed', 'Fu', 'ed@example.com');
insert into document_templates (id, kind, audience, title_en, slug) values
  ('33333333-3333-4333-8333-333333333a01', 'form', 'customer', 'CI year waiver', 'ci-year-waiver'),
  ('33333333-3333-4333-8333-333333333a02', 'read', 'customer', 'CI year notice', null),
  ('33333333-3333-4333-8333-333333333a03', 'sign', 'customer', 'CI year release', null);
insert into document_assignments (template_id, subject_type, subject_id, status, form_version, signer_email, completed_at) values
  ('33333333-3333-4333-8333-333333333a01', 'customer', '77777777-7777-4777-8777-777777777a01', 'completed', 1, 'ana@example.com', '2025-08-01Z'),
  ('33333333-3333-4333-8333-333333333a01', 'customer', '77777777-7777-4777-8777-777777777a02', 'completed', 1, 'ana@example.com', '2026-07-02Z'),
  ('33333333-3333-4333-8333-333333333a01', 'customer', '77777777-7777-4777-8777-777777777a04', 'completed', 1, 'bo@example.com', '2026-09-01Z'),
  ('33333333-3333-4333-8333-333333333a01', 'customer', '77777777-7777-4777-8777-777777777a04', 'completed', 1, 'cy@example.com', '2026-09-03Z'),
  ('33333333-3333-4333-8333-333333333a02', 'customer', '77777777-7777-4777-8777-777777777a05', 'completed', null, 'di@example.com', '2026-09-05Z'),
  ('33333333-3333-4333-8333-333333333a03', 'customer', '77777777-7777-4777-8777-777777777a06', 'completed', null, null, '2026-09-06Z');
insert into document_assignments (template_id, subject_type, subject_id, status, form_version, signer_email) values
  ('33333333-3333-4333-8333-333333333a01', 'customer', '77777777-7777-4777-8777-777777777a05', 'assigned', 1, 'di@example.com');

do $$
declare
  v_result text[];
begin
  select array_agg(customer_id::text || '=' || coalesce((signed_at at time zone 'UTC')::date::text, '-') order by customer_id)
    into v_result
    from customer_latest_signatures(array[
      '77777777-7777-4777-8777-777777777a01', '77777777-7777-4777-8777-777777777a02',
      '77777777-7777-4777-8777-777777777a03', '77777777-7777-4777-8777-777777777a04',
      '77777777-7777-4777-8777-777777777a05', '77777777-7777-4777-8777-777777777a06',
      '77777777-7777-4777-8777-777777777aff']::uuid[]);
  if v_result <> array[
       '77777777-7777-4777-8777-777777777a01=2026-07-02',
       '77777777-7777-4777-8777-777777777a02=2026-07-02',
       '77777777-7777-4777-8777-777777777a03=2026-09-01',
       '77777777-7777-4777-8777-777777777a04=2026-09-03',
       '77777777-7777-4777-8777-777777777a05=-',
       '77777777-7777-4777-8777-777777777a06=2026-09-06'] then
    raise exception 'customer_latest_signatures returned %', v_result;
  end if;
  if exists (select 1 from customer_latest_signatures('{}'::uuid[])) then
    raise exception 'customer_latest_signatures returned rows for no customers';
  end if;
end
$$;

do $$
declare
  v_waiver uuid := waiver_customer_for_email('New.Signer@example.com', 'New', 'Signer');
  v_other uuid := waiver_customer_for_email('other.signer@example.com', 'Other', 'Signer');
  v_shopify uuid;
begin
  if (select shopify_customer_id from customers where id = v_waiver) is not null then
    raise exception 'the probe expected a waiver-only customer row';
  end if;
  insert into document_assignments (template_id, subject_type, subject_id, status, form_version, signer_email, completed_at)
  values ('33333333-3333-4333-8333-333333333a01', 'customer', v_waiver, 'completed', 1, 'new.signer@example.com', '2026-10-01Z'),
         ('33333333-3333-4333-8333-333333333a01', 'customer', v_other, 'completed', 1, 'nobody.listed@example.com', '2026-10-02Z');

  if (select array_agg((signed_at at time zone 'UTC')::date::text) from admin_signature_check('NEW.SIGNER@example.com'))
     <> array['2026-10-01'] then
    raise exception 'admin_signature_check missed a signature filed under a waiver-only customer';
  end if;
  if (select array_agg((signed_at at time zone 'UTC')::date::text) from admin_signature_check('nobody.listed@example.com'))
     <> array['2026-10-02'] then
    raise exception 'admin_signature_check missed a signer email that no customer row has';
  end if;
  if (select signed_at from customer_latest_signatures(array[v_waiver])) <> '2026-10-01Z' then
    raise exception 'a waiver-only customer did not carry its own signature';
  end if;

  perform upsert_customer_if_newer(49100, 'New', 'Signer', 'new.signer@EXAMPLE.com', null, now());
  select id into v_shopify from customers where shopify_customer_id = 49100;
  if v_shopify is distinct from v_waiver then
    raise exception 'Shopify did not link the waiver-only customer with the same email';
  end if;
  if (select signed_at from customer_latest_signatures(array[v_shopify])) is distinct from '2026-10-01Z' then
    raise exception 'a customer linked to Shopify lost its earlier signature';
  end if;

  update document_assignments set subject_id = v_shopify
   where subject_id = v_other and status = 'completed';
  if (select signed_at from customer_latest_signatures(array[v_shopify])) is distinct from '2026-10-02Z' then
    raise exception 'a signature linked from a waiver-only customer did not count for the Shopify customer';
  end if;
  update document_assignments set subject_id = v_other
   where signer_email = 'nobody.listed@example.com';
  if (select signed_at from customer_latest_signatures(array[v_other])) is distinct from '2026-10-02Z' then
    raise exception 'a signature linked to a waiver-only customer did not count for it';
  end if;
end
$$;

do $$
declare
  v_original uuid := waiver_customer_for_email('original.a@example.com', 'Original', 'A');
  v_linked uuid := waiver_customer_for_email('linked.b@example.com', 'Linked', 'B');
  v_assignment uuid;
begin
  insert into document_assignments (template_id, subject_type, subject_id, status, form_version, signer_email, completed_at)
  values ('33333333-3333-4333-8333-333333333a01', 'customer', v_original, 'completed', 1, 'original.a@example.com', '2026-10-05Z')
  returning id into v_assignment;
  update document_assignments set subject_id = v_linked
   where id = v_assignment and subject_type = 'customer' and subject_id = v_original and status = 'completed';

  if (select signed_at from customer_latest_signatures(array[v_linked])) is distinct from '2026-10-05Z' then
    raise exception 'a signature linked to a different-email customer did not count for it';
  end if;
  if (select array_agg((signed_at at time zone 'UTC')::date::text) from admin_signature_check('Linked.B@example.com'))
     is distinct from array['2026-10-05'] then
    raise exception 'admin_signature_check missed a signature linked to that email''s customer';
  end if;
  if (select array_agg((signed_at at time zone 'UTC')::date::text) from admin_signature_check('original.a@example.com'))
     is distinct from array['2026-10-05'] then
    raise exception 'admin_signature_check lost the signer email after linking';
  end if;
end
$$;

insert into customers (id, first_name, last_name, email) values
  ('77777777-7777-4777-8777-777777777a07', 'Staff', 'Student', 'staff.student@example.com'),
  ('77777777-7777-4777-8777-777777777a08', 'Real', 'Student', 'real.student@example.com');
insert into auth.users (id, email) values
  ('11111111-1111-4111-8111-111111111a01', 'staff.student@example.com'),
  ('11111111-1111-4111-8111-111111111a02', 'ci.teacher@example.com');
insert into instructors (id, auth_user_id, email, approval_status, is_active) values
  ('22222222-2222-4222-8222-222222222a01', '11111111-1111-4111-8111-111111111a01', 'staff.student@example.com', 'approved', true),
  ('22222222-2222-4222-8222-222222222a02', '11111111-1111-4111-8111-111111111a02', 'ci.teacher@example.com', 'approved', true);
insert into document_templates (id, kind, audience, title_en, slug) values
  ('33333333-3333-4333-8333-333333333a04', 'sign', 'instructor', 'CI employment agreement', null);
insert into document_assignments (template_id, subject_type, subject_id, status, signer_email, completed_at) values
  ('33333333-3333-4333-8333-333333333a04', 'instructor', '22222222-2222-4222-8222-222222222a01', 'completed', 'staff.student@example.com', '2026-10-06Z');
insert into document_assignments (template_id, subject_type, subject_id, status, form_version, signer_email, completed_at) values
  ('33333333-3333-4333-8333-333333333a01', 'customer', '77777777-7777-4777-8777-777777777a08', 'completed', 1, 'real.student@example.com', '2026-10-07Z');
insert into classes (id, instructor_id, starts_at, ends_at, status) values
  ('44444444-4444-4444-8444-444444444a01', '22222222-2222-4222-8222-222222222a02', '2026-12-01 10:00Z', '2026-12-01 12:00Z', 'scheduled');
insert into class_participants (class_id, customer_id) values
  ('44444444-4444-4444-8444-444444444a01', '77777777-7777-4777-8777-777777777a07'),
  ('44444444-4444-4444-8444-444444444a01', '77777777-7777-4777-8777-777777777a08');

do $$
begin
  if (select signed_at from customer_latest_signatures(array['77777777-7777-4777-8777-777777777a07']::uuid[])) is not null then
    raise exception 'an instructor agreement counted as a customer waiver';
  end if;
  if exists (select 1 from admin_signature_check('staff.student@example.com')) then
    raise exception 'admin_signature_check counted an instructor agreement';
  end if;
  if (select array_agg(name || '=' || coalesce((signed_at at time zone 'UTC')::date::text, '-') order by name)
        from instructor_student_signatures('22222222-2222-4222-8222-222222222a02', '', 100))
     is distinct from array['Real Student=2026-10-07', 'Staff Student=-'] then
    raise exception 'instructor_student_signatures counted an instructor agreement or missed a customer waiver';
  end if;
end
$$;

set local role anon;
do $$
begin
  perform customer_latest_signatures(array['77777777-7777-4777-8777-777777777a01']::uuid[]);
  raise exception 'anon could call customer_latest_signatures';
exception when insufficient_privilege then null;
end
$$;
do $$
begin
  perform customer_waiver_signatures('ana@example.com');
  raise exception 'anon could call customer_waiver_signatures';
exception when insufficient_privilege then null;
end
$$;
reset role;

rollback;
