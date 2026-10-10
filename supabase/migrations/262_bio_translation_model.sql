alter table instructors add column if not exists bio_en_translated_by text;
alter table instructors add column if not exists bio_zh_translated_by text;

create or replace function public.clear_bio_translated_by()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if not new.bio_en_machine_translated
     and (new.bio_en is distinct from old.bio_en or old.bio_en_machine_translated) then
    new.bio_en_translated_by := null;
  end if;
  if not new.bio_zh_machine_translated
     and (new.bio_zh is distinct from old.bio_zh or old.bio_zh_machine_translated) then
    new.bio_zh_translated_by := null;
  end if;
  return new;
end;
$$;

revoke all on function public.clear_bio_translated_by()
  from public, anon, authenticated;

drop trigger if exists instructors_clear_bio_translated_by on instructors;
create trigger instructors_clear_bio_translated_by
  before update on instructors
  for each row execute function public.clear_bio_translated_by();
