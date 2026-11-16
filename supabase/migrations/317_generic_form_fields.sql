update document_form_versions
   set fields = (
     select jsonb_agg(
              case when f ->> 'key' = 'participant_name' and f ->> 'type' = 'text'
                   then jsonb_set(f, '{type}', '"full_name"')
                   else f
              end
              order by e.ord)
       from jsonb_array_elements(fields) with ordinality as e (f, ord)
   )
 where fields @> '[{"key": "participant_name", "type": "text"}]'::jsonb;

alter table document_form_versions
  drop constraint document_form_versions_body_length,
  add constraint document_form_versions_body_length
    check (char_length(body_markdown) <= 50000);
