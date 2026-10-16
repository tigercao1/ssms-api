create table if not exists seasons (
  key         text primary key
                constraint seasons_key_format_check check (key ~ '^\d{4}/\d{2}$'),
  starts_on   date not null,
  ends_on     date not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint seasons_range_check check (ends_on > starts_on),
  constraint seasons_no_overlap
    exclude using gist (daterange(starts_on, ends_on, '[]') with &&)
);

create or replace trigger seasons_set_updated_at
  before update on seasons
  for each row execute function public.set_updated_at();

insert into seasons (key, starts_on, ends_on)
values ('2026/27', date '2026-11-01', date '2027-04-30')
on conflict (key) do nothing;

do $$
declare
  v_bad text;
begin
  select string_agg(distinct s.season, ', ') into v_bad
    from (
      select season from document_templates
      union all select season from document_assignments
      union all select season from instructor_invites
    ) s
   where s.season is not null
     and s.season !~ '^\d{4}/\d{2}$';
  if v_bad is not null then
    raise exception 'seasons not in YYYY/YY format: %', v_bad;
  end if;

  insert into seasons (key, starts_on, ends_on)
  select s.season,
         make_date(left(s.season, 4)::int, 11, 1),
         make_date(left(s.season, 4)::int + 1, 4, 30)
    from (
      select season from document_templates
      union select season from document_assignments
      union select season from instructor_invites
    ) s
   where s.season is not null
  on conflict (key) do nothing;
end;
$$;

alter table document_templates
  add constraint document_templates_season_fkey
  foreign key (season) references seasons (key) on update cascade;

alter table document_assignments
  add constraint document_assignments_season_fkey
  foreign key (season) references seasons (key) on update cascade;

alter table instructor_invites
  add constraint instructor_invites_season_fkey
  foreign key (season) references seasons (key) on update cascade;

create index if not exists document_templates_season_idx on document_templates (season);
create index if not exists document_assignments_season_idx on document_assignments (season);
create index if not exists instructor_invites_season_idx on instructor_invites (season);

alter table seasons enable row level security;
alter table seasons force row level security;
revoke all on seasons from public, anon, authenticated;
