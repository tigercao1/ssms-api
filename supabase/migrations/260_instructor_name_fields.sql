-- Instructor sign-up name fields.
--
-- The portal's sign-up form (ssms-portal SignUpPage) now collects first name,
-- last name, and an optional nickname (WeChat name / name the instructor goes
-- by). These are captured as Supabase auth `user_metadata` at sign-up and
-- copied onto the instructors row when the backend lazily creates the
-- `pending` row on first verified call (InstructorsService.getOrCreateForUser).
--
-- first_name/last_name default to '' for the same reason display_name_en does
-- (migration 001): the row can be created before the metadata is readable.
-- nickname is optional, so it stays nullable with no default.

alter table instructors
  add column first_name text not null default '' check (char_length(first_name) <= 100),
  add column last_name  text not null default '' check (char_length(last_name) <= 100),
  add column nickname   text check (char_length(nickname) <= 100);

comment on column instructors.first_name is
  'Captured at sign-up from Supabase user_metadata.first_name.';
comment on column instructors.last_name is
  'Captured at sign-up from Supabase user_metadata.last_name.';
comment on column instructors.nickname is
  'Optional. Captured at sign-up from Supabase user_metadata.nickname (WeChat name or preferred name).';
