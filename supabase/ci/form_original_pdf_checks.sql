\set ON_ERROR_STOP on
begin;

insert into customers (id, shopify_customer_id, first_name, last_name, email) values
  ('77777777-7777-4777-8777-777777777901', null, 'Mia', 'Chen', 'mia@example.com');
insert into document_templates (id, kind, audience, title_en, slug) values
  ('33333333-3333-4333-8333-333333333901', 'form', 'customer', 'CI boat rental', 'ci-boat-rental'),
  ('33333333-3333-4333-8333-333333333902', 'form', 'customer', 'CI lesson waiver', 'ci-lesson-waiver');

do $$
begin
  if (select email_copy from document_templates where id = '33333333-3333-4333-8333-333333333901') is not true then
    raise exception 'a form does not email the signed copy by default';
  end if;
end
$$;

insert into document_form_versions (template_id, language, version, title, body_markdown, body_sha256,
                                    source_key, source_sha256, source_size_bytes, page_count, pages, placements)
values ('33333333-3333-4333-8333-333333333901', 'en', 1, 'Boat rental', 'Text', repeat('a', 64),
        'templates/33333333-3333-4333-8333-333333333901/forms/en/v1/source.pdf', repeat('b', 64), 1024, 2,
        '[{"width":612,"height":792,"rotate":0,"x":0,"y":0}]',
        '[{"key":"participant_name","page":1,"x":72,"y":600,"w":220,"h":24}]');
insert into document_form_versions (template_id, language, version, title, body_markdown, body_sha256)
values ('33333333-3333-4333-8333-333333333902', 'en', 1, 'Lesson waiver', 'Text', repeat('a', 64));

do $$
begin
  if (select pages || placements from document_form_versions
       where template_id = '33333333-3333-4333-8333-333333333902') <> '[]'::jsonb then
    raise exception 'a version without an original PDF does not default to no pages and no placements';
  end if;
  begin
    insert into document_form_versions (template_id, language, version, title, body_markdown, body_sha256, source_key)
    values ('33333333-3333-4333-8333-333333333902', 'zh', 1, 'W', 'T', repeat('a', 64), 'k.pdf');
    raise exception 'an original PDF without its hash, size and page count was accepted';
  exception when check_violation then null;
  end;
  begin
    insert into document_form_versions (template_id, language, version, title, body_markdown, body_sha256, placements)
    values ('33333333-3333-4333-8333-333333333902', 'zh', 1, 'W', 'T', repeat('a', 64),
            '[{"key":"email","page":1,"x":1,"y":1,"w":1,"h":1}]');
    raise exception 'placements without an original PDF were accepted';
  exception when check_violation then null;
  end;
  begin
    insert into document_form_versions (template_id, language, version, title, body_markdown, body_sha256,
                                        source_key, source_sha256, source_size_bytes, page_count)
    values ('33333333-3333-4333-8333-333333333902', 'zh', 1, 'W', 'T', repeat('a', 64), 'k.pdf', 'nothex', 1, 1);
    raise exception 'a malformed original PDF hash was accepted';
  exception when check_violation then null;
  end;
  begin
    insert into document_form_versions (template_id, language, version, title, body_markdown, body_sha256,
                                        source_key, source_sha256, source_size_bytes, page_count)
    values ('33333333-3333-4333-8333-333333333902', 'zh', 1, 'W', 'T', repeat('a', 64), 'k.pdf', repeat('c', 64), 1, 0);
    raise exception 'an original PDF with no pages was accepted';
  exception when check_violation then null;
  end;
end
$$;

insert into document_assignments (template_id, subject_type, subject_id, status, form_version, signer_email, completed_at) values
  ('33333333-3333-4333-8333-333333333901', 'customer', '77777777-7777-4777-8777-777777777901', 'completed', 1, 'mia@example.com', '2026-11-01Z'),
  ('33333333-3333-4333-8333-333333333902', 'customer', '77777777-7777-4777-8777-777777777901', 'completed', 1, 'mia@example.com', '2026-11-03Z'),
  ('33333333-3333-4333-8333-333333333902', 'customer', '77777777-7777-4777-8777-777777777901', 'completed', 1, 'Mia@Example.com', '2026-11-02Z'),
  ('33333333-3333-4333-8333-333333333901', 'customer', '77777777-7777-4777-8777-777777777901', 'completed', 1, 'mia@example.com.au', '2026-11-04Z');
insert into document_assignments (template_id, subject_type, subject_id, status, form_version, signer_email) values
  ('33333333-3333-4333-8333-333333333901', 'customer', '77777777-7777-4777-8777-777777777901', 'assigned', 1, 'pending@example.com');

do $$
begin
  if (select array_agg(title_en || '@' || (signed_at at time zone 'UTC')::date order by signed_at desc)
        from admin_signature_check(' MIA@example.com '))
     <> array['CI lesson waiver@2026-11-03', 'CI boat rental@2026-11-01'] then
    raise exception 'admin_signature_check did not return each signed template once with its latest date';
  end if;
  if exists (select 1 from admin_signature_check('mia@example')) then
    raise exception 'admin_signature_check matched a partial email';
  end if;
  if exists (select 1 from admin_signature_check('pending@example.com')) then
    raise exception 'admin_signature_check counted an unsigned assignment';
  end if;
end
$$;

set local role anon;
do $$
begin
  perform admin_signature_check('mia@example.com');
  raise exception 'anon could call admin_signature_check';
exception when insufficient_privilege then null;
end
$$;
reset role;

rollback;
