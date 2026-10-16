drop function if exists public.document_template_stats(uuid[]);

create function public.document_template_stats(p_template_ids uuid[])
returns table (
  template_id uuid,
  assigned_count int,
  completed_count int,
  has_completed boolean,
  approved_assigned_count int,
  approved_completed_count int
)
language sql
stable
set search_path = public
as $$
  select
    t.id,
    (count(a.id) filter (where a.season = t.season))::int,
    (count(a.id) filter (where a.season = t.season and a.status = 'completed'))::int,
    coalesce(bool_or(a.status = 'completed'), false),
    (count(a.id) filter (where a.season = t.season and i.id is not null))::int,
    (count(a.id) filter (
      where a.season = t.season and a.status = 'completed' and i.id is not null
    ))::int
  from document_templates t
  left join document_assignments a
    on a.template_id = t.id and a.status <> 'archived'
  left join instructors i
    on a.subject_type = 'instructor'
    and i.id = a.subject_id
    and i.approval_status = 'approved'
    and i.is_active
  where t.id = any(p_template_ids)
  group by t.id;
$$;

revoke all on function public.document_template_stats(uuid[])
  from public, anon, authenticated;
grant execute on function public.document_template_stats(uuid[])
  to service_role;
