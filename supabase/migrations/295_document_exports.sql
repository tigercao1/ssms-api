create table document_exports (
  id              uuid primary key default gen_random_uuid(),
  template_id     uuid not null references document_templates (id) on delete cascade,
  season          text
                    constraint document_exports_season_length
                    check (char_length(season) between 1 and 20),
  assignment_ids  uuid[]
                    constraint document_exports_assignment_ids_count
                    check (cardinality(assignment_ids) between 1 and 1000),
  status          text not null default 'queued'
                    constraint document_exports_status_check
                    check (status in ('queued', 'running', 'ready', 'failed', 'expired')),
  file_count      int
                    constraint document_exports_file_count_nonnegative
                    check (file_count >= 0),
  skipped_count   int
                    constraint document_exports_skipped_count_nonnegative
                    check (skipped_count >= 0),
  size_bytes      bigint
                    constraint document_exports_size_bytes_nonnegative
                    check (size_bytes >= 0),
  zip_key         text,
  error           text,
  requested_by    uuid not null,
  started_at      timestamptz,
  finished_at     timestamptz,
  expires_at      timestamptz,
  inserted_at     timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index document_exports_template_inserted_idx
  on document_exports (template_id, inserted_at desc);

create index document_exports_status_idx
  on document_exports (status);

create trigger document_exports_set_updated_at
  before update on document_exports
  for each row execute function public.set_updated_at();

alter table document_exports enable row level security;
alter table document_exports force row level security;
revoke all on document_exports from public, anon, authenticated;

comment on table document_exports is
  'Background ZIP exports of a template''s signed copies; the ZIP lives in the private R2 bucket for 24 hours, service_role only.';

create function public.document_template_assignments(
  p_template_id uuid,
  p_season text,
  p_status text,
  p_patterns text[],
  p_ids uuid[],
  p_signed_only boolean,
  p_limit int,
  p_offset int
)
returns table (
  id uuid,
  status text,
  season text,
  instructor_id uuid,
  first_name text,
  last_name text,
  email text,
  signer_name text,
  signer_email text,
  assigned_at timestamptz,
  viewed_at timestamptz,
  completed_at timestamptz,
  signed_sha256 text,
  signed_key text,
  total_count int
)
language sql
stable
set search_path = public
as $$
  select
    a.id,
    a.status,
    a.season,
    a.subject_id,
    i.first_name,
    i.last_name,
    i.email,
    a.signer_name,
    a.signer_email,
    a.assigned_at,
    a.viewed_at,
    a.completed_at,
    a.signed_sha256,
    a.signed_key,
    (count(*) over ())::int
  from document_assignments a
  left join instructors i on i.id = a.subject_id
  where a.template_id = p_template_id
    and a.subject_type = 'instructor'
    and a.status <> 'archived'
    and (p_season is null or a.season = p_season)
    and (
      p_status = 'all'
      or (p_status = 'completed' and a.status = 'completed')
      or (p_status = 'open' and a.status in ('assigned', 'viewed'))
    )
    and (p_ids is null or a.id = any(p_ids))
    and (not p_signed_only or a.signed_key is not null)
    and not exists (
      select 1
      from unnest(coalesce(p_patterns, '{}'::text[])) as p(pattern)
      where concat_ws(
        ' ', i.first_name, i.last_name, i.email, a.signer_name, a.signer_email
      ) not ilike p.pattern
    )
  order by
    (a.status = 'completed') desc,
    a.completed_at desc nulls last,
    i.last_name asc nulls last,
    i.first_name asc nulls last,
    a.id
  limit p_limit
  offset p_offset;
$$;

revoke all on function public.document_template_assignments(uuid, text, text, text[], uuid[], boolean, int, int)
  from public, anon, authenticated;
grant execute on function public.document_template_assignments(uuid, text, text, text[], uuid[], boolean, int, int)
  to service_role;
