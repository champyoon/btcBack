-- Review the LIVE schema first: rewards/attendances were created outside this repo.
-- No tables, constraints, policies or existing data are changed by this migration.
-- Missing prerequisites fail closed. Apply manually as the trusted database owner.
begin;
set local lock_timeout = '5s';

do $$
declare
  required record;
  relation regclass;
  role_name text;
begin
  if to_regclass('public.profiles') is null or to_regclass('public.attendances') is null
     or to_regclass('public.rewards') is null then
    raise exception 'Required profiles/attendances/rewards tables missing; review live schema';
  end if;
  lock table public.profiles, public.attendances, public.rewards in access share mode;
  for required in select * from (values
    ('attendances','id','uuid'), ('attendances','user_id','uuid'),
    ('attendances','attendance_date','date'), ('attendances','created_at','timestamp with time zone'),
    ('rewards','id','uuid'), ('rewards','user_id','uuid'),
    ('rewards','created_at','timestamp with time zone'), ('rewards','updated_at','timestamp with time zone'),
    ('rewards','confirmed_at','timestamp with time zone'), ('rewards','confirm_eligible_at','timestamp with time zone')
  ) as columns(table_name,column_name,type_name) loop
    if not exists (select 1 from pg_attribute a
      where a.attrelid=to_regclass('public.'||required.table_name) and a.attname=required.column_name
        and not a.attisdropped and format_type(a.atttypid,a.atttypmod)=required.type_name) then
      raise exception 'Missing or incompatible %.% column',required.table_name,required.column_name;
    end if;
  end loop;
  -- Resolve all remaining columns without reading/changing any row data.
  perform p.id,p.member_status from public.profiles p limit 0;
  perform r.source_type,r.merchant,r.source_txn_key,r.purchase_amount,r.purchase_currency,
    r.amount_sats,r.status from public.rewards r limit 0;
  if exists (select 1 from pg_attribute where attrelid='public.rewards'::regclass
    and attname in ('merchant','purchase_amount','purchase_currency','confirm_eligible_at') and attnotnull) then
    raise exception 'Attendance requires nullable purchase/merchant/eligibility columns';
  end if;
  if not exists (
    select 1 from pg_index i where i.indrelid='public.attendances'::regclass
      and i.indisunique and i.indisvalid and i.indisready and i.indimmediate
      and i.indpred is null and i.indexprs is null and i.indnkeyatts=2
      and (select array_agg(a.attname::text order by a.attname)
           from unnest(i.indkey::smallint[]) with ordinality k(num,pos)
           join pg_attribute a on a.attrelid=i.indrelid and a.attnum=k.num
           where k.pos<=i.indnkeyatts)=array['attendance_date','user_id']
  ) then raise exception 'Immediate UNIQUE(user_id, attendance_date) required; no constraint added'; end if;
  if not exists (
    select 1 from pg_index i join pg_attribute a on a.attrelid=i.indrelid and a.attnum=i.indkey[0]
    where i.indrelid='public.rewards'::regclass and i.indisunique and i.indisvalid
      and i.indisready and i.indimmediate and i.indpred is null and i.indexprs is null
      and i.indnkeyatts=1 and a.attname='source_txn_key'
  ) then raise exception 'Immediate UNIQUE(source_txn_key) required; review actual constraint, no constraint added'; end if;

  foreach relation in array array['public.attendances'::regclass,'public.rewards'::regclass] loop
    if not (select relrowsecurity from pg_class where oid=relation) then
      raise exception 'RLS must already be enabled on %',relation;
    end if;
    foreach role_name in array array['anon','authenticated'] loop
      if exists (select 1 from pg_roles r join pg_class c on c.oid=relation
        where r.rolname=role_name and (r.rolsuper or r.rolbypassrls or r.oid=c.relowner))
        or has_table_privilege(role_name,relation,'TRUNCATE') then
        raise exception 'Unsafe client privileges on % for %; review before applying',relation,role_name;
      end if;
      if exists (select 1 from pg_policy p where p.polrelid=relation and p.polpermissive
        and p.polcmd in ('a','w','d','*') and exists (
          select 1 from unnest(p.polroles) pr(role_oid)
          where case when pr.role_oid=0 then true
            else pg_has_role(role_name,pr.role_oid,'MEMBER') end)) then
        raise exception 'Client write policy on % for % requires review; no RLS changes made',relation,role_name;
      end if;
    end loop;
  end loop;
end;
$$;

create function public.attendance_logical_date(at_time timestamptz)
returns date language sql immutable strict set search_path = '' as $$
  select (at_time at time zone 'Asia/Seoul' - interval '6 hours')::date;
$$;

create function public.check_attendance()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  caller uuid := auth.uid();
  execution_time timestamptz := pg_catalog.statement_timestamp();
  logical_day date := public.attendance_logical_date(execution_time);
  attendance_id uuid;
  txn_key text;
  member_state text;
  reward_count integer;
begin
  if caller is null then
    raise exception 'Authentication required' using errcode='28000';
  end if;
  -- Serialize this member's calls and prevent approval revocation mid-operation.
  select p.member_status::text into member_state from public.profiles p
    where p.id=caller for update;
  if member_state is distinct from 'APPROVED' then
    raise exception 'Approved membership required' using errcode='42501';
  end if;
  txn_key := 'ATTENDANCE:' || caller::text || ':' || pg_catalog.to_char(logical_day,'YYYYMMDD');
  insert into public.attendances(id,user_id,attendance_date,created_at)
    values (pg_catalog.gen_random_uuid(),caller,logical_day,execution_time)
    on conflict (user_id,attendance_date) do nothing returning id into attendance_id;
  if attendance_id is null then
    -- Do not silently repair or label pre-existing orphan/manual data as rewarded.
    if not exists (select 1 from public.attendances a where a.user_id=caller and a.attendance_date=logical_day)
      or not exists (select 1 from public.rewards r where r.source_txn_key=txn_key
      and r.user_id=caller and r.source_type='ATTENDANCE' and r.status='CONFIRMED'
      and r.amount_sats=100 and r.merchant is null and r.purchase_amount is null
      and r.purchase_currency is null and r.confirm_eligible_at is null and r.confirmed_at is not null) then
      raise exception 'Attendance reward mismatch; review existing data' using errcode='23514';
    end if;
    return pg_catalog.jsonb_build_object('success',true,'already_attended',true,
      'attendance_date',logical_day,'reward_sats',0);
  end if;
  -- Any reward failure propagates: PostgreSQL rolls back this attendance too.
  insert into public.rewards(id,user_id,source_type,merchant,source_txn_key,
    purchase_amount,purchase_currency,amount_sats,status,confirm_eligible_at,
    confirmed_at,created_at,updated_at)
  values (pg_catalog.gen_random_uuid(),caller,'ATTENDANCE',null,txn_key,
    null,null,100,'CONFIRMED',null,execution_time,execution_time,execution_time);
  get diagnostics reward_count = row_count;
  if reward_count <> 1 then
    raise exception 'Attendance reward was not created' using errcode='23514';
  end if;
  return pg_catalog.jsonb_build_object('success',true,'already_attended',false,
    'attendance_date',logical_day,'reward_sats',100);
end;
$$;

alter function public.attendance_logical_date(timestamptz) owner to postgres;
alter function public.check_attendance() owner to postgres;
revoke all on function public.attendance_logical_date(timestamptz) from public,anon,authenticated;
revoke all on function public.check_attendance() from public,anon,authenticated;
grant execute on function public.check_attendance() to authenticated;
commit;
