create table public_pages (
  id                uuid primary key default gen_random_uuid(),
  slug              text not null unique
                      constraint public_pages_slug_format
                      check (
                        char_length(slug) between 1 and 80
                        and slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
                      ),
  title             text not null
                      constraint public_pages_title_length
                      check (char_length(title) between 1 and 200),
  status            text not null default 'draft'
                      constraint public_pages_status_check
                      check (status in ('draft', 'published')),
  draft_sha256      text,
  draft_size_bytes  int,
  published_sha256  text,
  published_at      timestamptz,
  created_by        uuid,
  updated_by        uuid,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index public_pages_updated_at_idx
  on public_pages (updated_at desc);

create trigger public_pages_set_updated_at
  before update on public_pages
  for each row execute function public.set_updated_at();

alter table public_pages enable row level security;
alter table public_pages force row level security;
revoke all on public_pages from public, anon, authenticated;

comment on table public_pages is
  'Admin-managed public HTML pages served by the docs Worker; HTML lives in R2, service_role only.';
