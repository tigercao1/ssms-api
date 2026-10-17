alter table document_templates
  add column if not exists source_language text
    constraint document_templates_source_language_check
    check (source_language in ('en', 'zh'));

create table if not exists document_template_translations (
  template_id     uuid not null references document_templates (id) on delete cascade,
  language        text not null
                    constraint document_template_translations_language_check
                    check (language in ('en', 'zh')),
  source_key      text,
  source_sha256   text
                    constraint document_template_translations_source_sha256_format
                    check (source_sha256 ~ '^[0-9a-f]{64}$'),
  page_count      int
                    constraint document_template_translations_page_count_positive
                    check (page_count > 0),
  pages           jsonb not null default '[]'::jsonb
                    constraint document_template_translations_pages_array
                    check (jsonb_typeof(pages) = 'array'),
  fields          jsonb not null default '[]'::jsonb
                    constraint document_template_translations_fields_array
                    check (jsonb_typeof(fields) = 'array'),
  updated_by      uuid,
  inserted_at     timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  primary key (template_id, language)
);

create trigger document_template_translations_set_updated_at
  before update on document_template_translations
  for each row execute function public.set_updated_at();

alter table document_template_translations enable row level security;
alter table document_template_translations force row level security;
revoke all on document_template_translations from public, anon, authenticated;

comment on table document_template_translations is
  'Other-language version of a document template (at most one per language, never the template''s own source_language); the PDF lives in the private R2 bucket, service_role only.';

alter table document_assignments
  add column if not exists language text
    constraint document_assignments_language_check
    check (language in ('en', 'zh'));
