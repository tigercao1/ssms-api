create or replace function public.customer_latest_signatures(p_customer_ids uuid[])
returns table (customer_id uuid, signed_at timestamptz)
language sql
stable
security invoker
set search_path = public
as $$
  select c.id,
         greatest(
           (select max(a.completed_at)
              from customers signer
              join document_assignments a
                on a.subject_type = 'customer'
               and a.subject_id = signer.id
               and a.status = 'completed'
              join document_templates t on t.id = a.template_id and t.kind in ('form', 'sign')
             where signer.id = c.id
                or lower(signer.email) = lower(c.email)),
           (select max(a.completed_at)
              from document_assignments a
              join document_templates t on t.id = a.template_id and t.kind in ('form', 'sign')
             where a.status = 'completed'
               and lower(a.signer_email) = lower(c.email)))
    from customers c
   where c.id = any(p_customer_ids);
$$;

revoke all on function public.customer_latest_signatures(uuid[])
  from public, anon, authenticated;
grant execute on function public.customer_latest_signatures(uuid[])
  to service_role;

create or replace function public.instructor_student_signatures(
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
  with students as (
    select c.id,
           nullif(btrim(concat_ws(' ', c.first_name, c.last_name)), '') as name
      from customers c
     where c.id in (
             select p.customer_id
               from class_participants p
               join classes k on k.id = p.class_id
              where k.instructor_id = p_instructor_id
                and k.status <> 'cancelled')
       and strpos(c.search_text, lower(btrim(coalesce(p_query, '')))) > 0
     order by 2 nulls last, c.id
     limit p_limit
  )
  select s.name, w.signed_at
    from students s
    join customer_latest_signatures(array(select id from students)) w
      on w.customer_id = s.id
   order by s.name nulls last, s.id;
$$;

revoke all on function public.instructor_student_signatures(uuid, text, int)
  from public, anon, authenticated;
grant execute on function public.instructor_student_signatures(uuid, text, int)
  to service_role;
