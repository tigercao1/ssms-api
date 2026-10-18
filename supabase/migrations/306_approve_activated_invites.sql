with latest_invites as (
  select distinct on (instructor_id) instructor_id, activated_at
    from instructor_invites
   order by instructor_id, created_at desc
),
approved as (
  update instructors i
     set approval_status = 'approved'
    from latest_invites l
   where l.instructor_id = i.id
     and l.activated_at is not null
     and i.approval_status = 'pending'
     and i.is_active
  returning i.id
)
insert into audit_log (actor_user_id, actor_role, action, target_type, target_id, metadata)
select null, 'system', 'instructor.approve', 'instructor', id,
       jsonb_build_object(
         'from', 'pending',
         'to', 'approved',
         'reason', null,
         'source', 'invite_activation_backfill'
       )
  from approved;
