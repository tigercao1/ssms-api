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
          and t.is_active = true
          and t.key = any (p_locations)
      ))
      and (p_languages is null or exists (
        select 1
        from instructors_languages j
        join languages l on l.id = j.language_id
        where j.instructor_id = i.id
          and l.is_active = true
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
    case when p_sort = 'seniority' and lower(coalesce(p_order, 'desc')) <> 'asc'
         then b.seniority end asc nulls last,
    case when p_sort = 'seniority' and lower(coalesce(p_order, 'desc')) = 'asc'
         then b.seniority end desc nulls last,
    case when p_sort <> 'seniority' and lower(coalesce(p_order, 'asc')) = 'desc'
         then b.sort_name end desc,
    case when p_sort <> 'seniority' and lower(coalesce(p_order, 'asc')) <> 'desc'
         then b.sort_name end asc,
    b.id
  limit greatest(coalesce(p_page_size, 50), 1)
  offset (greatest(coalesce(p_page, 1), 1) - 1) * greatest(coalesce(p_page_size, 50), 1);
$$;

revoke all on function public.public_list_instructors(
  text, integer, integer, text[], text[], text[], integer, integer, boolean, text, text
) from anon, authenticated;
