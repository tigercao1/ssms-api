-- T2.8 + T2.9: retire the pre-v1 reference-table cert model and the unused
-- disciplines table. Idempotent — this is a greenfield build, so these are
-- no-ops here, but the migration documents intent and stays safe if applied
-- against an older database. See CERTIFICATION_STRUCTURE.md / DATA_MODEL.md.

drop table if exists instructors_csia_certifications cascade;
drop table if exists instructors_casi_certifications cascade;
drop table if exists csia_certifications cascade;
drop table if exists casi_certifications cascade;
drop table if exists instructors_disciplines cascade;
drop table if exists disciplines cascade;
