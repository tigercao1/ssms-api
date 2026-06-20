-- Core instructors table.
-- Folds in T2.1 (approval_status), T2.2 (preferred_language), T2.3 (bilingual
-- display_name/bio + machine-translated flags), T2.4 (date_of_birth) because
-- this is a greenfield create (the originating plans assumed an existing table).
-- See INSTRUCTOR_PROFILE_FIELDS.md and DATA_MODEL.md.

create table instructors (
  id                          uuid primary key default gen_random_uuid(),
  auth_user_id                uuid not null unique references auth.users (id) on delete cascade,
  email                       text not null,

  -- display_name_en is required for display, but a pending row is created
  -- lazily on first GET /me/instructor before the user has typed anything,
  -- so default '' keeps creation valid; the API enforces non-empty on PATCH.
  display_name_en             text not null default '' check (char_length(display_name_en) <= 100),
  display_name_zh             text check (char_length(display_name_zh) <= 100),

  bio_en                      text check (char_length(bio_en) <= 1000),
  bio_zh                      text check (char_length(bio_zh) <= 1000),
  bio_en_machine_translated   boolean not null default false,
  bio_zh_machine_translated   boolean not null default false,

  date_of_birth               date check (date_of_birth < current_date),
  profile_photo_url           text,

  preferred_language          text not null default 'en'
                                check (preferred_language in ('en', 'zh-CN')),
  approval_status             text not null default 'pending'
                                check (approval_status in ('pending', 'approved', 'rejected')),
  is_active                   boolean not null default true,

  inserted_at                 timestamptz not null default now(),
  updated_at                  timestamptz not null default now()
);

-- Public-API filter path + JWT-subject lookup (DATA_MODEL.md § Indexes).
create index instructors_approval_status_idx on instructors (approval_status);
create index instructors_is_active_idx on instructors (is_active);
-- auth_user_id already has a unique index via the UNIQUE constraint.

create trigger instructors_set_updated_at
  before update on instructors
  for each row execute function public.set_updated_at();

comment on column instructors.email is
  'Mirrored from auth.users.email via trigger (014); not user-editable.';
comment on column instructors.approval_status is
  'pending -> approved/rejected. Gates public visibility only; editing allowed in any state.';
