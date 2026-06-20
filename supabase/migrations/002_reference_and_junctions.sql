-- Admin-managed reference tables (identical pattern) + instructor junctions.
-- DATA_MODEL.md § ref tables / Junction tables. Seeds are applied separately
-- by the Reference-data agent (T4.2, supabase/seed.sql).

create table teaching_locations (
  id          uuid primary key default gen_random_uuid(),
  key         text not null unique,
  name        text not null,
  sort_order  int not null default 0,
  is_active   boolean not null default true
);

create table languages (
  id          uuid primary key default gen_random_uuid(),
  key         text not null unique,
  name        text not null,
  sort_order  int not null default 0,
  is_active   boolean not null default true
);

create table course_levels_offered (
  id          uuid primary key default gen_random_uuid(),
  key         text not null unique,
  name        text not null,
  sort_order  int not null default 0,
  is_active   boolean not null default true
);

-- Many-to-many junctions. Composite PK, cascade from instructors.
create table instructors_teaching_locations (
  instructor_id         uuid not null references instructors (id) on delete cascade,
  teaching_location_id  uuid not null references teaching_locations (id) on delete cascade,
  primary key (instructor_id, teaching_location_id)
);

create table instructors_languages (
  instructor_id  uuid not null references instructors (id) on delete cascade,
  language_id    uuid not null references languages (id) on delete cascade,
  primary key (instructor_id, language_id)
);

create table instructors_course_levels_offered (
  instructor_id             uuid not null references instructors (id) on delete cascade,
  course_level_offered_id   uuid not null references course_levels_offered (id) on delete cascade,
  primary key (instructor_id, course_level_offered_id)
);
