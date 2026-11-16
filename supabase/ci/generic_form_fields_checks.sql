\set ON_ERROR_STOP on
begin;

insert into document_templates (id, kind, audience, title_en, slug) values
  ('33333333-3333-4333-8333-333333333911', 'form', 'customer', 'CI waiver', 'ci-generic-waiver'),
  ('33333333-3333-4333-8333-333333333912', 'form', 'customer', 'CI media release', 'ci-media-release');

insert into document_form_versions (template_id, language, version, title, body_markdown, body_sha256, fields)
values ('33333333-3333-4333-8333-333333333911', 'en', 1, 'Waiver', 'Text', repeat('a', 64),
        '[{"key":"participant_name","type":"text","label":"Name","required":true},
          {"key":"email","type":"email","label":"Email","required":true},
          {"key":"guardian_name","type":"text","label":"Guardian","required":false}]'),
       ('33333333-3333-4333-8333-333333333912', 'en', 1, 'Media release', '', repeat('a', 64),
        '[{"key":"model","type":"full_name","label":"Model","required":true}]');

\i supabase/migrations/317_generic_form_fields.sql
\i supabase/migrations/317_generic_form_fields.sql

do $$
begin
  if (select fields from document_form_versions
       where template_id = '33333333-3333-4333-8333-333333333911')
     <> '[{"key":"participant_name","type":"full_name","label":"Name","required":true},
          {"key":"email","type":"email","label":"Email","required":true},
          {"key":"guardian_name","type":"text","label":"Guardian","required":false}]'::jsonb then
    raise exception 'participant_name did not become a full_name field, or other fields or their order changed';
  end if;
  if (select fields from document_form_versions
       where template_id = '33333333-3333-4333-8333-333333333912')
     <> '[{"key":"model","type":"full_name","label":"Model","required":true}]'::jsonb then
    raise exception 'a form without participant_name was changed';
  end if;
  begin
    insert into document_form_versions (template_id, language, version, title, body_markdown, body_sha256)
    values ('33333333-3333-4333-8333-333333333912', 'zh', 1, 'T', repeat('x', 50001), repeat('a', 64));
    raise exception 'a body over 50000 characters was accepted';
  exception when check_violation then null;
  end;
end
$$;

rollback;
