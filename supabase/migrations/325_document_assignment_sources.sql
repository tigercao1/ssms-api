alter table document_assignments
  add column source text not null default 'ssms'
    constraint document_assignments_source_check
    check (source in ('ssms', 'jotform')),
  add column external_id text
    constraint document_assignments_external_id_length
    check (char_length(external_id) between 1 and 100),
  add column external_form_id text
    constraint document_assignments_external_form_id_length
    check (char_length(external_form_id) between 1 and 100),
  add constraint document_assignments_external_needs_import
    check ((source = 'ssms') = (external_id is null));

create unique index document_assignments_source_external_id_key
  on document_assignments (source, external_id)
  where external_id is not null;

drop function public.admin_signature_lookup(text, int);

create function public.admin_signature_lookup(p_query text, p_limit int)
returns table (
  subject_type    text,
  subject_id      uuid,
  name            text,
  email           text,
  assignment_id   uuid,
  template_id     uuid,
  title_en        text,
  title_zh        text,
  kind            text,
  language        text,
  form_version    int,
  signed_at       timestamptz,
  has_signed_copy boolean,
  source          text
)
language sql
stable
security invoker
set search_path = public
as $$
  with people as (
    (select 'instructor'::text as subject_type,
            i.id as subject_id,
            coalesce(nullif(btrim(concat_ws(' ', i.first_name, i.last_name)), ''),
                     i.display_name_en) as name,
            i.email
       from instructors i
      where strpos(lower(concat_ws(' ', i.first_name, i.last_name, i.display_name_en,
                                   i.display_name_zh, i.email)),
                   lower(btrim(p_query))) > 0
      order by 3, 2
      limit p_limit)
    union all
    (select 'customer'::text,
            c.id,
            nullif(btrim(concat_ws(' ', c.first_name, c.last_name)), ''),
            c.email
       from customers c
      where strpos(c.search_text, lower(btrim(p_query))) > 0
      order by 3 nulls last, 2
      limit p_limit)
  )
  select p.subject_type, p.subject_id, p.name, p.email,
         a.id, a.template_id, t.title_en, t.title_zh, t.kind, a.language,
         a.form_version, a.completed_at, a.signed_key is not null, a.source
    from people p
    left join document_assignments a
      on a.subject_type = p.subject_type
     and a.subject_id = p.subject_id
     and a.status = 'completed'
    left join document_templates t on t.id = a.template_id
   order by p.subject_type desc, p.name nulls last, p.subject_id, a.completed_at desc;
$$;

revoke all on function public.admin_signature_lookup(text, int)
  from public, anon, authenticated;
grant execute on function public.admin_signature_lookup(text, int)
  to service_role;
