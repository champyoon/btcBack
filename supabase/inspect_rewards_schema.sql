-- Read-only metadata inspection. No reward rows, account details or secrets.
-- Run manually in Supabase SQL Editor before drafting the cancellation migration.
select jsonb_pretty(jsonb_build_object(
  'columns', (select jsonb_agg(jsonb_build_object(
    'name',a.attname,'type',format_type(a.atttypid,a.atttypmod),
    'not_null',a.attnotnull,'default',pg_get_expr(d.adbin,d.adrelid)) order by a.attnum)
    from pg_attribute a left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
    where a.attrelid=to_regclass('public.rewards') and a.attnum>0 and not a.attisdropped),
  'constraints', (select jsonb_agg(jsonb_build_object(
    'name',conname,'type',contype,'definition',pg_get_constraintdef(oid)))
    from pg_constraint where conrelid=to_regclass('public.rewards')),
  'indexes', (select jsonb_agg(jsonb_build_object('name',indexname,'definition',indexdef))
    from pg_indexes where schemaname='public' and tablename='rewards'),
  'policies', (select jsonb_agg(to_jsonb(p)) from pg_policies p
    where schemaname='public' and tablename='rewards'),
  'grants', (select jsonb_agg(jsonb_build_object('role',grantee,'privilege',privilege_type))
    from information_schema.table_privileges where table_schema='public' and table_name='rewards'),
  'triggers', (select jsonb_agg(jsonb_build_object(
    'name',t.tgname,'definition',pg_get_triggerdef(t.oid),'function',t.tgfoid::regprocedure::text))
    from pg_trigger t where t.tgrelid=to_regclass('public.rewards') and not t.tgisinternal),
  'row_security', (select relrowsecurity from pg_class where oid=to_regclass('public.rewards'))
)) as rewards_schema;
