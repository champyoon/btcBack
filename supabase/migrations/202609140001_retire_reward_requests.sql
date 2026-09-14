-- MANUAL REVIEW ONLY. Verify an operational backup BEFORE executing.
-- Deploy the retired form/admin UI first. Review pending and paid history.
-- Nonempty data is blocked unless the operator explicitly changes 'no' to 'yes'.
-- This does not migrate data into rewards or alter rewards/attendances/admin_users.
begin;
set local lock_timeout = '5s';
set local btcback.legacy_reward_backup_confirmed = 'no';

do $$
declare
  target oid := to_regclass('public.reward_requests');
  validator oid := to_regprocedure('public.validate_reward_status_transition()');
  item record;
  columns_sql text;
begin
  if target is null then
    if validator is not null then
      raise exception 'Table absent but status validator remains; review its ownership manually';
    end if;
    return;
  end if;
  lock table public.reward_requests in access exclusive mode;
  if exists (select 1 from public.reward_requests)
     and current_setting('btcback.legacy_reward_backup_confirmed', true) is distinct from 'yes' then
    raise exception 'Existing reward_requests data: verify backup/history, then explicitly confirm in this migration';
  end if;
  if exists (select 1 from pg_constraint where confrelid = target) then
    raise exception 'Foreign keys reference reward_requests; review dependents first';
  end if;
  if exists (select 1 from pg_trigger where tgfoid = validator and tgrelid <> target) then
    raise exception 'Status validator is used by another table; no objects removed';
  end if;
  if exists (select 1 from pg_trigger where tgrelid = target and not tgisinternal
    and (tgname <> 'reward_status_transition' or tgfoid is distinct from validator)) then
    raise exception 'Unexpected trigger on reward_requests; review manually';
  end if;
  if exists (select 1 from pg_policy where polrelid = target and polname not in
    ('reward_requests_anon_insert','reward_requests_admin_select','reward_requests_admin_update')) then
    raise exception 'Unexpected RLS policy on reward_requests; review manually';
  end if;
  -- PL/pgSQL/dynamic SQL may not register table dependencies. Stop on textual uses.
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname not in ('pg_catalog','information_schema') and p.prokind in ('f','p')
      and p.oid is distinct from validator and p.prosrc ilike '%reward_requests%') then
    raise exception 'Another routine mentions reward_requests; review it before retirement';
  end if;
  if exists (select 1 from pg_constraint where conrelid=target and contype not in ('c','p','u','n')) then
    raise exception 'Unexpected constraint on reward_requests; review manually';
  end if;

  drop trigger if exists reward_status_transition on public.reward_requests;
  drop policy if exists reward_requests_anon_insert on public.reward_requests;
  drop policy if exists reward_requests_admin_select on public.reward_requests;
  drop policy if exists reward_requests_admin_update on public.reward_requests;
  -- These constraints belong to this table. RESTRICT refuses external dependents.
  -- PostgreSQL 18 NOT NULL catalog entries remain until the final table drop.
  for item in select conname from pg_constraint where conrelid=target and contype <> 'n' loop
    execute format('alter table public.reward_requests drop constraint %I restrict', item.conname);
  end loop;
  revoke all privileges on public.reward_requests from public, anon, authenticated;
  select string_agg(quote_ident(attname), ', ' order by attnum) into columns_sql
    from pg_attribute where attrelid=target and attnum>0 and not attisdropped;
  execute format('revoke all privileges (%s) on public.reward_requests from public, anon, authenticated', columns_sql);
end;
$$;

-- RESTRICT also protects view/rule/type dependencies unknown to this repository.
-- Explicit function drop fails if another object still uses it; transaction rolls back.
drop function if exists public.validate_reward_status_transition() restrict;
drop table if exists public.reward_requests restrict;
commit;
