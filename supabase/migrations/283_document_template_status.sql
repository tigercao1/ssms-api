-- Onboarding document templates move from an Active toggle to a lifecycle:
-- draft -> live -> retired (and retired -> live on re-publish). Publishing
-- records the audience (`all` approved instructors, or `selected` by hand) and
-- the season it is published for.
--
-- `is_active` stays: the release that is live while this runs still reads it,
-- and the new code keeps writing `is_active = (status = 'live')` so a rollback
-- still behaves. A later migration drops it.

alter table document_templates
  add column status text not null default 'draft'
    constraint document_templates_status_check
    check (status in ('draft', 'live', 'retired')),
  add column assign_to text
    constraint document_templates_assign_to_check
    check (assign_to in ('all', 'selected')),
  add column season text
    constraint document_templates_season_length
    check (char_length(season) between 1 and 20),
  add column published_at timestamptz,
  add column published_by uuid;

-- Backfill from `is_active` and the template's assignments:
--   active + a non-archived assignment -> live (`all` if required, else
--     `selected`), season = its most common assignment season
--   inactive + any assignment          -> retired
--   anything else                      -> draft
-- A template that qualifies as live but has no assignment with a season is
-- retired instead, since a live template needs a season.
with stats as (
  select
    t.id,
    t.is_active,
    t.required,
    exists (
      select 1 from document_assignments a
      where a.template_id = t.id and a.status <> 'archived'
    ) as has_open,
    exists (
      select 1 from document_assignments a where a.template_id = t.id
    ) as has_any,
    (
      select a.season
      from document_assignments a
      where a.template_id = t.id
        and a.status <> 'archived'
        and a.season is not null
      group by a.season
      order by count(*) desc, a.season desc
      limit 1
    ) as top_season
  from document_templates t
)
update document_templates t
set
  status = case
    when s.is_active and s.has_open and s.top_season is not null then 'live'
    when s.is_active and s.has_open then 'retired'
    when not s.is_active and s.has_any then 'retired'
    else 'draft'
  end,
  assign_to = case
    when s.is_active and s.has_open and s.top_season is not null
      then case when s.required then 'all' else 'selected' end
  end,
  season = case
    when s.is_active and s.has_open and s.top_season is not null
      then s.top_season
  end
from stats s
where s.id = t.id;

alter table document_templates
  add constraint document_templates_live_published
  check (status <> 'live' or (assign_to is not null and season is not null));

create index document_templates_status_assign_to_idx
  on document_templates (status, assign_to);
