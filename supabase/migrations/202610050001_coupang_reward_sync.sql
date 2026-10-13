-- Review live rewards DDL and back up data before manual execution. No automatic deployment.
-- Requires an existing amount_sats constraint that permits zero for cancelled shopping rewards.
-- Existing rewards/profiles/attendance policies, grants and constraints are NOT weakened here.
begin;
set local lock_timeout = '5s';

do $$
begin
  perform id,user_id,source_type,merchant,source_txn_key,purchase_amount,purchase_currency,
    amount_sats,status,confirm_eligible_at,confirmed_at,created_at,updated_at from public.rewards limit 0;
  perform id,coupang_sub_id from public.profiles limit 0;
  perform user_id from public.admin_users limit 0;
  if not exists (
    select 1 from pg_index i join pg_attribute a on a.attrelid=i.indrelid and a.attnum=i.indkey[0]
    where i.indrelid='public.rewards'::regclass and i.indisunique and i.indisvalid
      and i.indisready and i.indimmediate and i.indpred is null and i.indexprs is null
      and i.indnkeyatts=1 and a.attname='source_txn_key'
  ) then raise exception 'Immediate UNIQUE(source_txn_key) required'; end if;
  if exists (select 1 from pg_constraint where conrelid='public.rewards'::regclass
    and contype='c' and pg_get_constraintdef(oid) ~ 'amount_sats > 0') then
    raise exception 'Review positive-only amount_sats CHECK before applying: full cancellation requires zero. No constraint changed';
  end if;
end;
$$;

alter table public.rewards
  add column cancellation_status text check (cancellation_status in ('PARTIAL','FULL')),
  add column cancelled_at timestamptz;

create table public.rewards_history (
  id uuid primary key default gen_random_uuid(),
  reward_id uuid not null references public.rewards(id) on delete cascade,
  event_key text not null unique,
  event_type text not null check (event_type in ('PURCHASE','CANCEL')),
  event_date date not null,
  product_id text,
  gmv numeric not null,
  commission numeric not null,
  amount_sats bigint not null,
  created_at timestamptz not null default now()
);
create index rewards_history_reward_id_idx on public.rewards_history(reward_id);
alter table public.rewards_history enable row level security;
revoke all on public.rewards_history from public,anon,authenticated;
grant select on public.rewards_history to service_role;

-- Only the Edge Function's server credential can call this RPC. It rechecks admin membership.
create function public.sync_coupang_rewards(p_admin_id uuid, p_events jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  raw jsonb;
  events jsonb := '[]'::jsonb;
  event_type text;
  event_day date;
  gmv numeric;
  commission numeric;
  sats bigint;
  key text;
  order_key text;
  group_events jsonb;
  event record;
  channel text;
  member_id uuid;
  matches integer;
  current_reward public.rewards%rowtype;
  v_reward_id uuid;
  purchase_day date;
  net_gmv numeric;
  net_sats bigint;
  latest_cancel date;
  inserted integer;
  changed integer;
  created_count integer := 0;
  history_count integer := 0;
  updated_count integer := 0;
  duplicate_count integer := 0;
  skipped jsonb := '[]'::jsonb;
begin
  perform 1 from public.admin_users where user_id=p_admin_id for share;
  if not found then raise exception 'Admin required' using errcode='42501'; end if;
  if p_events is null or jsonb_typeof(p_events)<>'array' or jsonb_array_length(p_events)>5000 then
    raise exception 'Invalid event batch' using errcode='22023';
  end if;
  for raw in select value from jsonb_array_elements(p_events) loop
    event_type := raw->>'event_type';
    if jsonb_typeof(raw)<>'object' or event_type is null or event_type not in ('PURCHASE','CANCEL')
      or coalesce(raw->>'order_id','') !~ '^[1-9][0-9]{0,39}$'
      or coalesce(raw->>'product_id','') !~ '^[1-9][0-9]{0,39}$'
      or coalesce(raw->>'event_date','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      or coalesce(jsonb_typeof(raw->'gmv'),'')<>'number'
      or coalesce(jsonb_typeof(raw->'commission'),'')<>'number'
      or (raw->>'sub_id' is not null and length(raw->>'sub_id')>100) then
      raise exception 'Invalid event' using errcode='22023';
    end if;
    event_day := (raw->>'event_date')::date;
    if event_day < date '2018-11-01' or event_day > (now() at time zone 'Asia/Seoul')::date then
      raise exception 'Invalid event date' using errcode='22023';
    end if;
    gmv := trim_scale((raw->>'gmv')::numeric);
    commission := trim_scale((raw->>'commission')::numeric);
    if abs(gmv)>9007199254740991 or abs(commission)>9007199254740991
      or (event_type='PURCHASE' and (gmv<0 or commission<0))
      or (event_type='CANCEL' and (gmv>0 or commission>0)) then
      raise exception 'Invalid event amounts' using errcode='22023';
    end if;
    -- Fixed historical test quote: 100,000,000 KRW/BTC, 90% allocation, floor PER EVENT.
    sats := (sign(commission) * floor(abs(commission) * 0.90))::bigint;
    key := event_type||':'||(raw->>'order_id')||':'||(raw->>'product_id')||':'||
      to_char(event_day,'YYYYMMDD')||':'||gmv::text||':'||commission::text;
    events := events || jsonb_build_array(raw || jsonb_build_object('event_key',key,'amount_sats',sats));
  end loop;

  -- Serialize manual syncs; each projection/history batch commits or rolls back together.
  perform pg_advisory_xact_lock(20261005,1);
  for order_key in select distinct value->>'order_id' from jsonb_array_elements(events) order by 1 loop
    select jsonb_agg(value) into group_events from jsonb_array_elements(events) where value->>'order_id'=order_key;
    select * into current_reward from public.rewards where source_txn_key='COUPANG:'||order_key for update;
    v_reward_id := current_reward.id;
    if v_reward_id is not null and current_reward.status='CONFIRMED' then
      skipped := skipped || jsonb_build_array(jsonb_build_object('orderId',order_key,'reason','confirmed_unchanged'));
      continue;
    end if;
    select count(distinct value->>'sub_id'),min(value->>'sub_id') into matches,channel from jsonb_array_elements(group_events);
    if matches=0 or channel='' then
      skipped := skipped || jsonb_build_array(jsonb_build_object('orderId',order_key,'reason','unmapped_subid'));
      continue;
    end if;
    if matches<>1 or exists(select 1 from jsonb_array_elements(group_events) where nullif(value->>'sub_id','') is null) then
      raise exception 'Conflicting order attribution' using errcode='23514';
    end if;
    -- Lock matching profiles against reassignment while this batch is applied.
    perform 1 from public.profiles where coupang_sub_id=channel for share;
    select count(*),(array_agg(id))[1] into matches,member_id from public.profiles where coupang_sub_id=channel;
    if matches=0 then
      skipped := skipped || jsonb_build_array(jsonb_build_object('orderId',order_key,'reason','unmapped_subid'));
      continue;
    elsif matches<>1 then raise exception 'Ambiguous channel mapping' using errcode='23514'; end if;
    if v_reward_id is not null and (current_reward.user_id<>member_id or current_reward.source_type<>'SHOPPING'
      or current_reward.merchant is distinct from 'COUPANG' or current_reward.purchase_currency is distinct from 'KRW') then
      raise exception 'Existing reward ownership/type mismatch' using errcode='23514';
    end if;
    select min((value->>'event_date')::date) into purchase_day from jsonb_array_elements(group_events)
      where value->>'event_type'='PURCHASE';
    if v_reward_id is null and purchase_day is null then
      skipped := skipped || jsonb_build_array(jsonb_build_object('orderId',order_key,'reason','purchase_missing'));
      continue;
    end if;
    if v_reward_id is not null and not exists(select 1 from public.rewards_history h where h.reward_id=v_reward_id) then
      -- Adopt manually seeded test rewards only with a complete matching purchase baseline.
      select sum((value->>'gmv')::numeric),sum((value->>'amount_sats')::bigint) into net_gmv,net_sats
      from (select distinct value from jsonb_array_elements(group_events) where value->>'event_type'='PURCHASE') purchases;
      if purchase_day is null or current_reward.status<>'PENDING'
        or current_reward.purchase_amount is distinct from net_gmv or current_reward.amount_sats is distinct from net_sats then
        raise exception 'Existing reward needs complete matching purchase baseline' using errcode='23514';
      end if;
    end if;
    if v_reward_id is null then
      select sum((value->>'gmv')::numeric),sum((value->>'amount_sats')::bigint) into net_gmv,net_sats
      from (select distinct value from jsonb_array_elements(group_events) where value->>'event_type'='PURCHASE') purchases;
      insert into public.rewards(id,user_id,source_type,merchant,source_txn_key,purchase_amount,purchase_currency,
        amount_sats,status,confirm_eligible_at,confirmed_at,created_at,updated_at)
      values(gen_random_uuid(),member_id,'SHOPPING','COUPANG','COUPANG:'||order_key,net_gmv,'KRW',net_sats,'PENDING',
        (purchase_day+60)::timestamp at time zone 'Asia/Seoul',null,
        purchase_day::timestamp at time zone 'Asia/Seoul',now()) returning id into v_reward_id;
      created_count := created_count+1;
    end if;
    for event in select * from jsonb_to_recordset(group_events) as e(event_key text,event_type text,event_date date,
      product_id text,gmv numeric,commission numeric,amount_sats bigint) loop
      insert into public.rewards_history(reward_id,event_key,event_type,event_date,product_id,gmv,commission,amount_sats)
        values(v_reward_id,event.event_key,event.event_type,event.event_date,event.product_id,event.gmv,event.commission,event.amount_sats)
        on conflict(event_key) do nothing;
      get diagnostics inserted=row_count;
      if inserted=0 and not exists(select 1 from public.rewards_history h where h.event_key=event.event_key
        and h.reward_id=v_reward_id and h.event_type=event.event_type and h.event_date=event.event_date
        and h.product_id is not distinct from event.product_id and h.gmv=event.gmv
        and h.commission=event.commission and h.amount_sats=event.amount_sats) then
        raise exception 'Existing history event mismatch' using errcode='23514';
      end if;
      history_count := history_count+inserted;
      duplicate_count := duplicate_count+(1-inserted);
    end loop;
    select sum(h.gmv),sum(h.amount_sats),max(h.event_date) filter(where h.event_type='CANCEL')
      into net_gmv,net_sats,latest_cancel from public.rewards_history h where h.reward_id=v_reward_id;
    if net_sats<0 and (latest_cancel is null or net_gmv>0) then
      raise exception 'Negative remaining reward requires review' using errcode='23514';
    end if;
    update public.rewards r set
      purchase_amount=case when latest_cancel is not null and net_gmv<=0 then 0 else net_gmv end,
      amount_sats=case when latest_cancel is not null and net_gmv<=0 then 0 else net_sats end,
      status=case when latest_cancel is not null and net_gmv<=0 then 'CANCELLED' when true then 'PENDING' else r.status end,
      cancellation_status=case when latest_cancel is null then null when net_gmv>0 then 'PARTIAL' else 'FULL' end,
      cancelled_at=latest_cancel::timestamp at time zone 'Asia/Seoul', updated_at=now()
    where r.id=v_reward_id and (
      r.purchase_amount is distinct from (case when latest_cancel is not null and net_gmv<=0 then 0 else net_gmv end)
      or r.amount_sats is distinct from (case when latest_cancel is not null and net_gmv<=0 then 0 else net_sats end)
      or r.status::text is distinct from (case when latest_cancel is not null and net_gmv<=0 then 'CANCELLED' else 'PENDING' end)
      or r.cancellation_status is distinct from (case when latest_cancel is null then null when net_gmv>0 then 'PARTIAL' else 'FULL' end)
      or r.cancelled_at is distinct from (latest_cancel::timestamp at time zone 'Asia/Seoul'));
    get diagnostics changed=row_count;
    updated_count := updated_count+changed;
  end loop;
  return jsonb_build_object('created_rewards',created_count,'inserted_events',history_count,
    'duplicate_events',duplicate_count,'updated_rewards',updated_count,'skipped',skipped);
end;
$$;
alter function public.sync_coupang_rewards(uuid,jsonb) owner to postgres;
revoke all on function public.sync_coupang_rewards(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.sync_coupang_rewards(uuid,jsonb) to service_role;
commit;
