create table if not exists booking_batch_rows (
  batch_id      uuid not null,
  row_index     int not null
                  constraint booking_batch_rows_row_index_check
                  check (row_index >= 0),
  payload_hash  text not null
                  constraint booking_batch_rows_payload_hash_check
                  check (payload_hash ~ '^[0-9a-f]{64}$'),
  class_id      uuid not null
                  constraint booking_batch_rows_class_id_key unique
                  references classes (id) on delete cascade,
  created_by    uuid,
  created_at    timestamptz not null default now(),
  constraint booking_batch_rows_pkey primary key (batch_id, row_index)
);

alter table booking_batch_rows enable row level security;
alter table booking_batch_rows force row level security;
revoke all on booking_batch_rows from public, anon, authenticated;

create or replace function public.book_batch_row(
  p_batch_id uuid,
  p_row_index int,
  p_payload_hash text,
  p_class jsonb
) returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_existing booking_batch_rows%rowtype;
  v_class_id uuid := (p_class->>'id')::uuid;
begin
  perform pg_advisory_xact_lock(
    hashtextextended('booking_batch_rows:' || p_batch_id::text || ':' || p_row_index::text, 0)
  );

  select * into v_existing
    from booking_batch_rows
   where batch_id = p_batch_id
     and row_index = p_row_index;
  if found then
    return jsonb_build_object(
      'outcome', 'existing',
      'row_index', v_existing.row_index,
      'payload_hash', v_existing.payload_hash,
      'class_id', v_existing.class_id
    );
  end if;

  perform book_classes(null, jsonb_build_array(p_class));

  insert into booking_batch_rows (batch_id, row_index, payload_hash, class_id, created_by)
  values (
    p_batch_id,
    p_row_index,
    p_payload_hash,
    v_class_id,
    (p_class->>'created_by')::uuid
  );

  return jsonb_build_object(
    'outcome', 'created',
    'row_index', p_row_index,
    'payload_hash', p_payload_hash,
    'class_id', v_class_id
  );
end;
$$;

revoke all on function public.book_batch_row(uuid, int, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.book_batch_row(uuid, int, text, jsonb)
  to service_role;
