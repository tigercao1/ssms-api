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
