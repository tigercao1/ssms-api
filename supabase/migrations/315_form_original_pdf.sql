alter table document_templates
  add column email_copy boolean not null default true;

alter table document_form_versions
  add column source_key text,
  add column source_sha256 text
    constraint document_form_versions_source_sha256_format
    check (source_sha256 ~ '^[0-9a-f]{64}$'),
  add column source_size_bytes int
    constraint document_form_versions_source_size_positive
    check (source_size_bytes > 0),
  add column page_count int
    constraint document_form_versions_page_count_positive
    check (page_count > 0),
  add column pages jsonb not null default '[]'::jsonb
    constraint document_form_versions_pages_array
    check (jsonb_typeof(pages) = 'array'),
  add column placements jsonb not null default '[]'::jsonb
    constraint document_form_versions_placements_array
    check (jsonb_typeof(placements) = 'array'),
  add constraint document_form_versions_source_complete
    check (
      (source_key is null and source_sha256 is null and source_size_bytes is null
        and page_count is null and pages = '[]'::jsonb and placements = '[]'::jsonb)
      or (source_key is not null and source_sha256 is not null
        and source_size_bytes is not null and page_count is not null)
    );

create index document_assignments_completed_signer_email_idx
  on document_assignments (lower(signer_email))
  where status = 'completed';

create function public.admin_signature_check(p_email text)
returns table (title_en text, signed_at timestamptz)
language sql
stable
security invoker
set search_path = public
as $$
  select t.title_en, max(a.completed_at)
    from document_assignments a
    join document_templates t on t.id = a.template_id and t.kind in ('sign', 'form')
   where a.status = 'completed'
     and lower(a.signer_email) = lower(btrim(p_email))
   group by t.id, t.title_en
   order by 2 desc, 1;
$$;

revoke all on function public.admin_signature_check(text)
  from public, anon, authenticated;
grant execute on function public.admin_signature_check(text)
  to service_role;
