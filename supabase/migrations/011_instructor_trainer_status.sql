-- T2.7 instructor_trainer_status. Sparse: one row per discipline only when an
-- instructor enters trainer info. CERTIFICATION_STRUCTURE.md § Trainers.

create table instructor_trainer_status (
  id                        uuid primary key default gen_random_uuid(),
  instructor_id             uuid not null references instructors (id) on delete cascade,
  discipline                text not null check (discipline in ('ski', 'snowboard')),
  rookie_session_completed  boolean not null default false,
  trainer_exam_passed       boolean not null default false,  -- CSIA only; informational for CASI
  trainer_level             int check (trainer_level between 1 and 4),
  inserted_at               timestamptz not null default now(),
  updated_at                timestamptz not null default now(),

  unique (instructor_id, discipline),

  -- Officially a trainer (trainer_level set) requires the rookie session.
  constraint trainer_level_requires_rookie
    check (trainer_level is null or rookie_session_completed = true)
);

create index instructor_trainer_status_instructor_idx
  on instructor_trainer_status (instructor_id);

create trigger instructor_trainer_status_set_updated_at
  before update on instructor_trainer_status
  for each row execute function public.set_updated_at();
