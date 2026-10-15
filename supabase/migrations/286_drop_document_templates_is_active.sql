-- Template status replaced is_active in 283; the API stopped reading and
-- writing it in the previous release.
drop index if exists document_templates_audience_active_idx;

alter table document_templates drop column is_active;
