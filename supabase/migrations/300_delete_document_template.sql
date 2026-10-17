create function public.delete_document_template(p_template_id uuid)
returns int
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_removed int;
begin
  perform 1
  from document_templates
  where id = p_template_id
  for update;

  if not found then
    raise exception 'document template % not found', p_template_id
      using errcode = 'P0002';
  end if;

  if exists (
    select 1
    from document_assignments
    where template_id = p_template_id
      and (status = 'completed' or completed_at is not null)
  ) then
    raise exception 'document template % has completed assignments', p_template_id
      using errcode = '55000';
  end if;

  delete from document_assignments
  where template_id = p_template_id
    and status <> 'completed'
    and completed_at is null;
  get diagnostics v_removed = row_count;

  delete from document_templates where id = p_template_id;

  return v_removed;
end;
$$;

revoke all on function public.delete_document_template(uuid)
  from public, anon, authenticated;
grant execute on function public.delete_document_template(uuid)
  to service_role;

create or replace function public.document_template_stats(p_template_ids uuid[])
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
    exists (
      select 1 from document_assignments c
      where c.template_id = t.id
        and (c.status = 'completed' or c.completed_at is not null)
    ),
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
