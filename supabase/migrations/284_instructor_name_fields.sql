alter table instructors
  add column if not exists first_name text
    constraint instructors_first_name_check
    check (char_length(first_name) between 1 and 100),
  add column if not exists last_name text
    constraint instructors_last_name_check
    check (char_length(last_name) between 1 and 100);
