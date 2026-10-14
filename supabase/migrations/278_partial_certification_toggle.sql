-- A partial certification is an on/off flag: the components a partial covers
-- are optional. Existing component values are kept.
alter table instructor_certifications
  drop constraint if exists cert_partial_has_components;
