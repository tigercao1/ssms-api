create table document_templates (
  id              uuid primary key default gen_random_uuid(),
  kind            text not null
                    constraint document_templates_kind_check
                    check (kind in ('sign', 'read')),
  audience        text not null
                    constraint document_templates_audience_check
                    check (audience in ('instructor', 'customer')),
  title_en        text not null
                    constraint document_templates_title_en_length
                    check (char_length(btrim(title_en)) between 1 and 200),
  title_zh        text
                    constraint document_templates_title_zh_length
                    check (char_length(title_zh) <= 200),
  description_en  text
                    constraint document_templates_description_en_length
                    check (char_length(description_en) <= 2000),
  description_zh  text
                    constraint document_templates_description_zh_length
                    check (char_length(description_zh) <= 2000),
  required        boolean not null default true,
  is_active       boolean not null default true,
  sort_order      int not null default 0,
  source_key      text,
  source_sha256   text
                    constraint document_templates_source_sha256_format
                    check (source_sha256 ~ '^[0-9a-f]{64}$'),
  page_count      int
                    constraint document_templates_page_count_positive
                    check (page_count > 0),
  pages           jsonb not null default '[]'::jsonb
                    constraint document_templates_pages_array
                    check (jsonb_typeof(pages) = 'array'),
  fields          jsonb not null default '[]'::jsonb
                    constraint document_templates_fields_array
                    check (jsonb_typeof(fields) = 'array'),
  updated_by      uuid,
  inserted_at     timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index document_templates_audience_active_idx
  on document_templates (audience, is_active, sort_order);

create table document_assignments (
  id                 uuid primary key default gen_random_uuid(),
  template_id        uuid not null references document_templates (id),
  subject_type       text not null
                       constraint document_assignments_subject_type_check
                       check (subject_type in ('instructor', 'customer')),
  subject_id         uuid not null,
  season             text
                       constraint document_assignments_season_length
                       check (char_length(season) between 1 and 20),
  class_id           uuid references classes (id) on delete set null,
  status             text not null default 'assigned'
                       constraint document_assignments_status_check
                       check (status in ('assigned', 'viewed', 'completed', 'archived')),
  assigned_at        timestamptz not null default now(),
  viewed_at          timestamptz,
  completed_at       timestamptz,
  due_at             timestamptz,
  reminder_sent_at   timestamptz,
  signer_name        text,
  signer_email       text,
  signer_ip          text,
  signer_user_agent  text,
  consent_at         timestamptz,
  template_sha256    text
                       constraint document_assignments_template_sha256_format
                       check (template_sha256 ~ '^[0-9a-f]{64}$'),
  signed_key         text,
  signed_sha256      text
                       constraint document_assignments_signed_sha256_format
                       check (signed_sha256 ~ '^[0-9a-f]{64}$'),
  field_values       jsonb not null default '{}'::jsonb
                       constraint document_assignments_field_values_object
                       check (jsonb_typeof(field_values) = 'object'),
  token_hash         text
                       constraint document_assignments_token_hash_sha256
                       check (token_hash ~ '^[0-9a-f]{64}$'),
  token_expires_at   timestamptz,
  inserted_at        timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint document_assignments_token_has_expiry
    check (token_hash is null or token_expires_at is not null)
);

create unique index document_assignments_open_key
  on document_assignments (template_id, subject_type, subject_id, coalesce(season, ''))
  where status <> 'archived';

create index document_assignments_subject_idx
  on document_assignments (subject_type, subject_id);

create index document_assignments_status_idx
  on document_assignments (status);

create unique index document_assignments_token_hash_key
  on document_assignments (token_hash)
  where token_hash is not null;

create table certification_uploads (
  id                       uuid primary key default gen_random_uuid(),
  instructor_id            uuid not null references instructors (id) on delete cascade,
  org                      text not null
                             constraint certification_uploads_org_check
                             check (org in ('csia', 'casi')),
  track                    text not null
                             constraint certification_uploads_track_check
                             check (track in ('regular', 'park', 'carving')),
  file_key                 text not null,
  sha256                   text not null
                             constraint certification_uploads_sha256_format
                             check (sha256 ~ '^[0-9a-f]{64}$'),
  content_type             text not null,
  size_bytes               int not null
                             constraint certification_uploads_size_bytes_positive
                             check (size_bytes > 0),
  review_status            text not null default 'pending'
                             constraint certification_uploads_review_status_check
                             check (review_status in ('pending', 'approved', 'rejected')),
  review_note              text,
  reviewed_by              uuid,
  reviewed_at              timestamptz,
  valid_until              date not null,
  expiry_reminder_sent_at  timestamptz,
  ai_result                jsonb,
  ai_model                 text,
  ai_checked_at            timestamptz,
  inserted_at              timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

create index certification_uploads_current_idx
  on certification_uploads (instructor_id, org, track, inserted_at desc);

create index certification_uploads_valid_until_idx
  on certification_uploads (valid_until);

create trigger document_templates_set_updated_at
  before update on document_templates
  for each row execute function public.set_updated_at();

create trigger document_assignments_set_updated_at
  before update on document_assignments
  for each row execute function public.set_updated_at();

create trigger certification_uploads_set_updated_at
  before update on certification_uploads
  for each row execute function public.set_updated_at();

alter table document_templates enable row level security;
alter table document_templates force row level security;
revoke all on document_templates from public, anon, authenticated;

alter table document_assignments enable row level security;
alter table document_assignments force row level security;
revoke all on document_assignments from public, anon, authenticated;

alter table certification_uploads enable row level security;
alter table certification_uploads force row level security;
revoke all on certification_uploads from public, anon, authenticated;

comment on table document_templates is
  'Onboarding document templates (sign or read); the source PDF lives in the private R2 bucket, service_role only.';
comment on table document_assignments is
  'One document per subject (instructor or customer) and season, with signing evidence; signed PDFs live in the private R2 bucket, service_role only.';
comment on table certification_uploads is
  'Instructor certification proof per (instructor_id, org, track); the latest row is current. Files live in the private R2 bucket, service_role only.';
