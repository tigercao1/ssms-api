\set ON_ERROR_STOP on
begin;

insert into customers (id, shopify_customer_id, first_name, last_name, email) values
  ('77777777-7777-4777-8777-777777777b01', null, 'Jo', 'Tform', 'jo@example.com');
insert into document_templates (id, kind, audience, title_en, slug) values
  ('33333333-3333-4333-8333-333333333b01', 'form', 'customer', 'CI source waiver', 'ci-source-waiver');
insert into document_assignments (id, template_id, subject_type, subject_id, status, language, completed_at,
                                  source, external_id, external_form_id, signed_key) values
  ('44444444-4444-4444-8444-444444444b01', '33333333-3333-4333-8333-333333333b01', 'customer',
   '77777777-7777-4777-8777-777777777b01', 'completed', 'zh', '2026-11-01T15:00:00Z',
   'jotform', '6693587400114977419', '242658653833264', 'subjects/customer/x/documents/y.pdf'),
  ('44444444-4444-4444-8444-444444444b02', '33333333-3333-4333-8333-333333333b01', 'customer',
   '77777777-7777-4777-8777-777777777b01', 'completed', 'en', '2026-10-02T15:00:00Z',
   default, null, null, null);

do $$
begin
  if (select source from document_assignments where id = '44444444-4444-4444-8444-444444444b02') <> 'ssms' then
    raise exception 'an assignment without a source did not default to ssms';
  end if;
  if (select array_agg(source order by signed_at desc) from admin_signature_lookup('jo@example', 10)
       where subject_id = '77777777-7777-4777-8777-777777777b01')
     <> array['jotform', 'ssms'] then
    raise exception 'admin_signature_lookup did not return each signature''s source';
  end if;
  if (select signed_at from customer_latest_signatures(array['77777777-7777-4777-8777-777777777b01']::uuid[]))
     <> '2026-11-01T15:00:00Z' then
    raise exception 'customer_latest_signatures did not count an imported Jotform signature';
  end if;
  if (select max(signed_at) from admin_signature_check('JO@example.com')) <> '2026-11-01T15:00:00Z' then
    raise exception 'admin_signature_check did not count an imported Jotform signature';
  end if;
end
$$;

do $$
begin
  insert into document_assignments (template_id, subject_type, subject_id, status, completed_at, source, external_id)
  values ('33333333-3333-4333-8333-333333333b01', 'customer', '77777777-7777-4777-8777-777777777b01',
          'completed', now(), 'jotform', '6693587400114977419');
  raise exception 'a second import of one Jotform submission was accepted';
exception when unique_violation then null;
end
$$;

do $$
begin
  insert into document_assignments (template_id, subject_type, subject_id, status, completed_at, source)
  values ('33333333-3333-4333-8333-333333333b01', 'customer', '77777777-7777-4777-8777-777777777b01',
          'completed', now(), 'jotform');
  raise exception 'an imported assignment without an external id was accepted';
exception when check_violation then null;
end
$$;

do $$
begin
  insert into document_assignments (template_id, subject_type, subject_id, status, completed_at, external_id)
  values ('33333333-3333-4333-8333-333333333b01', 'customer', '77777777-7777-4777-8777-777777777b01',
          'completed', now(), '123');
  raise exception 'an SSMS assignment with an external id was accepted';
exception when check_violation then null;
end
$$;

rollback;
\echo 'Document assignment source checks passed.'
