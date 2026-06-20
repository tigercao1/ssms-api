-- ============================================================================
-- T4.2 — Reference-data seed (Reference-data agent, 22x).
--
-- Idempotent: every statement uses ON CONFLICT (key) DO NOTHING, so this file
-- is safe to run repeatedly and is the SINGLE source used by BOTH the test
-- fixtures and the production seed (see T4.2 acceptance criteria).
--
-- `key` doubles as the i18n key the frontend resolves to a localized label;
-- `name` is the canonical/default (English) display string. `sort_order`
-- drives deterministic dropdown ordering.
--
-- Scope (REFERENCE_DATA_BEST_PRACTICES.md): locations, languages,
-- course levels offered, exam preparations.
--
-- NOT seeded here: CSIA/CASI certifications. Per CERTIFICATION_STRUCTURE.md
-- these are per-instructor records in `instructor_certifications`, NOT
-- reference data — the old csia/casi reference tables + seed-certifications.sql
-- are retired.
-- ============================================================================

-- ── Teaching locations ─────────────────────────────────────────────────────
insert into teaching_locations (key, name, sort_order) values
  ('teaching_location.whistler_blackcomb', 'Whistler Blackcomb', 10),
  ('teaching_location.lake_louise',        'Lake Louise',        20),
  ('teaching_location.banff_sunshine',     'Banff Sunshine',     30),
  ('teaching_location.big_white',          'Big White',          40),
  ('teaching_location.sun_peaks',          'Sun Peaks',          50),
  ('teaching_location.silver_star',        'Silver Star',        60),
  ('teaching_location.revelstoke',         'Revelstoke',         70),
  ('teaching_location.kicking_horse',      'Kicking Horse',      80),
  ('teaching_location.mont_tremblant',     'Mont-Tremblant',     90),
  ('teaching_location.blue_mountain',      'Blue Mountain',     100)
on conflict (key) do nothing;

-- ── Languages ──────────────────────────────────────────────────────────────
insert into languages (key, name, sort_order) values
  ('language.en',  'English',             10),
  ('language.fr',  'French',              20),
  ('language.zh',  'Mandarin Chinese',    30),
  ('language.yue', 'Cantonese',           40),
  ('language.ja',  'Japanese',            50),
  ('language.ko',  'Korean',              60),
  ('language.es',  'Spanish',             70),
  ('language.de',  'German',              80),
  ('language.it',  'Italian',             90),
  ('language.pt',  'Portuguese',         100)
on conflict (key) do nothing;

-- ── Course levels offered ──────────────────────────────────────────────────
insert into course_levels_offered (key, name, sort_order) values
  ('course_level.never_ever',   'Never-Ever / First Timer', 10),
  ('course_level.beginner',     'Beginner',                 20),
  ('course_level.intermediate', 'Intermediate',             30),
  ('course_level.advanced',     'Advanced',                 40),
  ('course_level.expert',       'Expert',                   50),
  ('course_level.kids',         'Children',                 60),
  ('course_level.private',      'Private Lessons',          70)
on conflict (key) do nothing;

-- ── Exam preparations ──────────────────────────────────────────────────────
-- Prep courses an instructor can deliver toward CSIA (ski) / CASI (snowboard)
-- certification exams.
insert into exam_preparations (key, name, sort_order) values
  ('exam_prep.csia_level_1', 'CSIA Level 1 Preparation', 10),
  ('exam_prep.csia_level_2', 'CSIA Level 2 Preparation', 20),
  ('exam_prep.csia_level_3', 'CSIA Level 3 Preparation', 30),
  ('exam_prep.csia_level_4', 'CSIA Level 4 Preparation', 40),
  ('exam_prep.casi_level_1', 'CASI Level 1 Preparation', 50),
  ('exam_prep.casi_level_2', 'CASI Level 2 Preparation', 60),
  ('exam_prep.casi_level_3', 'CASI Level 3 Preparation', 70),
  ('exam_prep.casi_level_4', 'CASI Level 4 Preparation', 80)
on conflict (key) do nothing;
