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
  has_signed_copy boolean
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
         a.form_version, a.completed_at, a.signed_key is not null
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

create function public.instructor_student_signatures(
  p_instructor_id uuid,
  p_query text,
  p_limit int
)
returns table (name text, signed_at timestamptz)
language sql
stable
security invoker
set search_path = public
as $$
  select nullif(btrim(concat_ws(' ', c.first_name, c.last_name)), ''),
         (select max(a.completed_at)
            from customers signer
            join document_assignments a
              on a.subject_type = 'customer'
             and a.subject_id = signer.id
             and a.status = 'completed'
            join document_templates t on t.id = a.template_id and t.kind = 'form'
           where signer.id = c.id
              or lower(signer.email) = lower(c.email))
    from customers c
   where c.id in (
           select p.customer_id
             from class_participants p
             join classes k on k.id = p.class_id
            where k.instructor_id = p_instructor_id
              and k.status <> 'cancelled')
     and strpos(c.search_text, lower(btrim(coalesce(p_query, '')))) > 0
   order by 1 nulls last, c.id
   limit p_limit;
$$;

revoke all on function public.instructor_student_signatures(uuid, text, int)
  from public, anon, authenticated;
grant execute on function public.instructor_student_signatures(uuid, text, int)
  to service_role;
