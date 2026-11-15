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

set local role anon;
do $$
begin
  perform customer_latest_signatures(array['77777777-7777-4777-8777-777777777a01']::uuid[]);
  raise exception 'anon could call customer_latest_signatures';
exception when insufficient_privilege then null;
end
$$;
reset role;

rollback;
