alter table certification_uploads
  add column if not exists verified_level int;

update certification_uploads u
   set verified_level = c.level
  from instructor_certifications c
 where u.review_status = 'approved'
   and u.verified_level is null
   and c.instructor_id = u.instructor_id
   and c.org = u.org
   and c.track = u.track;
