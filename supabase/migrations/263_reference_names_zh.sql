alter table teaching_locations add column if not exists name_zh text;
alter table teaching_locations add column if not exists name_zh_translated_by text;
alter table teaching_locations add column if not exists name_en_translated_by text;

alter table languages add column if not exists name_zh text;
alter table languages add column if not exists name_zh_translated_by text;
alter table languages add column if not exists name_en_translated_by text;

alter table course_levels_offered add column if not exists name_zh text;
alter table course_levels_offered add column if not exists name_zh_translated_by text;
alter table course_levels_offered add column if not exists name_en_translated_by text;

alter table exam_preparations add column if not exists name_zh text;
alter table exam_preparations add column if not exists name_zh_translated_by text;
alter table exam_preparations add column if not exists name_en_translated_by text;
