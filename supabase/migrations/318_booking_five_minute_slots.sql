alter table booking_settings
  drop constraint booking_settings_slot_minutes_check,
  add constraint booking_settings_slot_minutes_check
    check (slot_minutes in (5, 15, 30, 60));
