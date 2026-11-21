alter table lesson_types
  add constraint lesson_types_duration_min_step_check
    check (duration_min % 5 = 0);
