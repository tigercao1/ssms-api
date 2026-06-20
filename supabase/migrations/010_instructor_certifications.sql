-- T2.6 instructor_certifications. Highest-only per (instructor, org, track).
-- Full spec + CHECK rationale: CERTIFICATION_STRUCTURE.md.

create table instructor_certifications (
  id                  uuid primary key default gen_random_uuid(),
  instructor_id       uuid not null references instructors (id) on delete cascade,
  org                 text not null check (org in ('csia', 'casi')),
  track               text not null check (track in ('regular', 'park', 'carving')),
  level               int  not null,
  is_partial          boolean not null default false,
  partial_components  text[] not null default '{}',
  achieved_on         date,
  inserted_at         timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  unique (instructor_id, org, track),

  -- carving is CASI-only
  constraint cert_carving_is_casi
    check (track <> 'carving' or org = 'casi'),
  -- regular levels 1..4
  constraint cert_regular_level
    check (track <> 'regular' or level between 1 and 4),
  -- park levels 1..2 and never partial
  constraint cert_park_level
    check (track <> 'park' or (level between 1 and 2 and is_partial = false)),
  -- carving never partial
  constraint cert_carving_not_partial
    check (track <> 'carving' or is_partial = false),
  -- partial requires at least one component
  constraint cert_partial_has_components
    check (is_partial = false or array_length(partial_components, 1) >= 1),
  -- partial_components vocabulary by org. '<@' = "is contained by";
  -- empty array is contained by anything, so this also forces non-partial rows
  -- (which keep '{}') to stay within vocabulary. CHECK cannot use subqueries,
  -- so we compare against an org-keyed allowed set expression.
  constraint cert_partial_components_vocab
    check (
      partial_components <@ case org
        when 'csia' then array['ski', 'teach']
        when 'casi' then array['instructor_training', 'riding', 'teaching']
        else array[]::text[]
      end
    )
);

-- "all CSIA L3+" style queries / public filters (DATA_MODEL.md § Indexes).
create index instructor_certifications_org_track_level_idx
  on instructor_certifications (org, track, level);
create index instructor_certifications_instructor_idx
  on instructor_certifications (instructor_id);

create trigger instructor_certifications_set_updated_at
  before update on instructor_certifications
  for each row execute function public.set_updated_at();
