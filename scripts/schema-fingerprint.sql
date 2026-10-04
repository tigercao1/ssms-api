-- One line per schema object in public, plus the migration tracking rows.
-- .github/workflows/schema-drift.yml compares its hash between dev and prod;
-- `./scripts/db.sh fingerprint` prints it for a local diff.
\pset format unaligned
\pset tuples_only on
select 'col|'||c.table_name||'.'||c.column_name||'|'||c.data_type||'|'||c.is_nullable||'|'||coalesce(c.column_default,'') from information_schema.columns c where c.table_schema='public'
union all select 'con|'||conrelid::regclass||'.'||conname||'|'||pg_get_constraintdef(oid) from pg_constraint where connamespace='public'::regnamespace
union all select 'idx|'||indexname||'|'||indexdef from pg_indexes where schemaname='public'
union all select 'fn|'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')|'||md5(pg_get_functiondef(p.oid)) from pg_proc p where p.pronamespace='public'::regnamespace and p.prokind in ('f','p')
union all select 'view|'||viewname||'|'||md5(definition) from pg_views where schemaname='public'
union all select 'trg|'||tgrelid::regclass||'.'||tgname||'|'||pg_get_triggerdef(oid) from pg_trigger where not tgisinternal and tgrelid in (select oid from pg_class where relnamespace='public'::regnamespace)
union all select 'pol|'||tablename||'.'||policyname||'|'||cmd||'|'||array_to_string(roles,',')||'|'||coalesce(qual,'')||'|'||coalesce(with_check,'') from pg_policies where schemaname='public'
union all select 'rls|'||relname||'|'||relrowsecurity||'|'||relforcerowsecurity from pg_class where relnamespace='public'::regnamespace and relkind='r'
union all select 'grant|'||table_name||'|'||grantee||'|'||privilege_type from information_schema.role_table_grants where table_schema='public'
union all select 'migration|'||filename||'|'||checksum from ssms_meta.schema_migrations
order by 1;
