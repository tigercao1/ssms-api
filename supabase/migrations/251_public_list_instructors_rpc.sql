-- T7.1/T7.4/T7.5/T7.6 — Public instructor list: filtering + sorting +
-- pagination in a single set-returning function. See PUBLIC_API_PLAN.md
-- § List endpoint.
--
-- Visibility (LOCKED): only approval_status = 'approved' AND is_active = true.
-- The function returns just the page's instructor ids (in display order) plus a
-- window `total_count`, so NestJS can fetch the public columns + relations for
-- at most one page (<=50) of ids. Internal columns never leave the DB here.
--
-- Filter semantics (PUBLIC_API_PLAN.md § Filter semantics):
--   * repeated values for one param  -> OR   (key = ANY(array))
--   * different params               -> AND  (predicates compose)
--   * discipline=ski   satisfied by any CSIA cert; snowboard by any CASI cert
--   * min_csia/min_casi level filter the REGULAR track only; partials count
--     (a 'Level 3 Partial' row still stores level = 3, so level >= 3 matches)
--   * trainers_only -> any trainer_status row with trainer_level set
--
-- Sort semantics:
--   * name      -> locale-aware display name (zh-CN falls back to _en), asc default
--   * seniority -> earliest instructor_certifications.achieved_on, desc default;
--                  instructors with no achieved_on sort LAST in either direction
--   * tie-break -> id (stable across pages)

create or replace function public.public_list_instructors(
  p_locale        text    default 'en',
  p_page          integer default 1,
  p_page_size     integer default 50,
  p_locations     text[]  default null,
  p_languages     text[]  default null,
  p_disciplines   text[]  default null,
  p_min_csia      integer default null,
  p_min_casi      integer default null,
  p_trainers_only boolean default false,
  p_sort          text    default 'name',
  p_order         text    default null
) returns table (id uuid, total_count bigint)
language sql
stable
as $$
  with base as (
    select
      i.id,
      coalesce(
        case when p_locale = 'zh-CN' then nullif(i.display_name_zh, '') end,
        i.display_name_en
      ) as sort_name,
      (
        select min(c.achieved_on)
        from instructor_certifications c
        where c.instructor_id = i.id
      ) as seniority
    from instructors i
    where i.approval_status = 'approved'
      and i.is_active = true
      and (p_locations is null or exists (
        select 1
        from instructors_teaching_locations j
        join teaching_locations t on t.id = j.teaching_location_id
        where j.instructor_id = i.id
          and t.key = any (p_locations)
      ))
      and (p_languages is null or exists (
        select 1
        from instructors_languages j
        join languages l on l.id = j.language_id
        where j.instructor_id = i.id
          and l.key = any (p_languages)
      ))
      and (p_disciplines is null or (
        ('ski' = any (p_disciplines) and exists (
          select 1 from instructor_certifications c
          where c.instructor_id = i.id and c.org = 'csia'
        ))
        or
        ('snowboard' = any (p_disciplines) and exists (
          select 1 from instructor_certifications c
          where c.instructor_id = i.id and c.org = 'casi'
        ))
      ))
      and (p_min_csia is null or exists (
        select 1 from instructor_certifications c
        where c.instructor_id = i.id
          and c.org = 'csia' and c.track = 'regular'
          and c.level >= p_min_csia
      ))
      and (p_min_casi is null or exists (
        select 1 from instructor_certifications c
        where c.instructor_id = i.id
          and c.org = 'casi' and c.track = 'regular'
          and c.level >= p_min_casi
      ))
      and (coalesce(p_trainers_only, false) = false or exists (
        select 1 from instructor_trainer_status ts
        where ts.instructor_id = i.id
          and ts.trainer_level is not null
      ))
  )
  select
    b.id,
    count(*) over () as total_count
  from base b
  order by
    -- seniority, default order 'desc' = MOST SENIOR FIRST = earliest achieved_on
    -- first (ascending date). order 'asc' = least senior first (latest date).
    -- Instructors with no achieved_on always sort LAST (nulls last) either way.
    case when p_sort = 'seniority' and lower(coalesce(p_order, 'desc')) <> 'asc'
         then b.seniority end asc nulls last,
    case when p_sort = 'seniority' and lower(coalesce(p_order, 'desc')) = 'asc'
         then b.seniority end desc nulls last,
    -- name descending
    case when p_sort <> 'seniority' and lower(coalesce(p_order, 'asc')) = 'desc'
         then b.sort_name end desc,
    -- name ascending (default)
    case when p_sort <> 'seniority' and lower(coalesce(p_order, 'asc')) <> 'desc'
         then b.sort_name end asc,
    b.id
  limit greatest(coalesce(p_page_size, 50), 1)
  offset (greatest(coalesce(p_page, 1), 1) - 1) * greatest(coalesce(p_page_size, 50), 1);
$$;

comment on function public.public_list_instructors is
  'T7.1/4/5/6 public instructor list: approved+active only, OR-within/AND-across '
  'filters, name|seniority sort, offset pagination. Returns page ids + total_count.';

-- Service-role (NestJS) path only; never exposed to anon/authenticated.
revoke all on function public.public_list_instructors(
  text, integer, integer, text[], text[], text[], integer, integer, boolean, text, text
) from anon, authenticated;

-- Supporting index for the seniority sort / min-level filters: the existing
-- instructor_certifications_org_track_level_idx (migration 010) already covers
-- (org, track, level); add (instructor_id, achieved_on) for the per-instructor
-- earliest-achieved_on subquery used by the seniority sort.
create index if not exists instructor_certifications_instructor_achieved_idx
  on instructor_certifications (instructor_id, achieved_on);
