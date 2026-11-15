create or replace function public.customer_waiver_signatures(
  p_email text,
  p_customer_id uuid default null
)
returns table (assignment_id uuid, template_id uuid, signed_at timestamptz)
language sql
stable
security invoker
set search_path = public
as $$
  select a.id, a.template_id, a.completed_at
    from document_assignments a
    join document_templates t on t.id = a.template_id and t.kind in ('form', 'sign')
   where a.subject_type = 'customer'
     and a.status = 'completed'
     and a.id in (
           select d.id
             from document_assignments d
            where d.subject_type = 'customer'
              and d.subject_id = p_customer_id
           union
           select d.id
             from document_assignments d
            where d.status = 'completed'
              and lower(d.signer_email) = lower(btrim(p_email))
           union
           select d.id
             from customers c
             join document_assignments d
               on d.subject_type = 'customer'
              and d.subject_id = c.id
            where lower(c.email) = lower(btrim(p_email)));
$$;

revoke all on function public.customer_waiver_signatures(text, uuid)
  from public, anon, authenticated;
grant execute on function public.customer_waiver_signatures(text, uuid)
  to service_role;

create or replace function public.customer_latest_signatures(p_customer_ids uuid[])
returns table (customer_id uuid, signed_at timestamptz)
language sql
stable
security invoker
set search_path = public
as $$
  select c.id,
         (select max(s.signed_at) from customer_waiver_signatures(c.email, c.id) s)
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

create or replace function public.admin_signature_check(p_email text)
returns table (title_en text, signed_at timestamptz)
language sql
stable
security invoker
set search_path = public
as $$
  select t.title_en, max(s.signed_at)
    from customer_waiver_signatures(p_email) s
    join document_templates t on t.id = s.template_id
   group by t.id, t.title_en
   order by 2 desc, 1;
$$;

revoke all on function public.admin_signature_check(text)
  from public, anon, authenticated;
grant execute on function public.admin_signature_check(text)
  to service_role;
