-- MANUAL REVIEW/APPLY ONLY. Pause sync calls during the coordinated RPC/Edge rollout.
-- Existing sats and non-null quote metadata are never rewritten.
begin;
set local lock_timeout = '5s';
alter table public.rewards
  add column if not exists btc_krw_rate numeric(20,2),
  add column if not exists btc_rate_at timestamptz,
  add column if not exists btc_rate_source text;

do $$
begin
  if exists (
    select 1 from (values ('btc_krw_rate','numeric(20,2)'),
      ('btc_rate_at','timestamp with time zone'),('btc_rate_source','text')) expected(name,typ)
    left join pg_attribute a on a.attrelid='public.rewards'::regclass and a.attname=expected.name and not a.attisdropped
    where a.attname is null or format_type(a.atttypid,a.atttypmod)<>expected.typ
  ) then raise exception 'Review existing quote column types'; end if;
end;
$$;

-- Evidence-based legacy adoption only: complete fixed-rate history matching projection.
-- History-less/manual or partially populated metadata needs operator review; never guess.
update public.rewards r set btc_krw_rate=100000000,btc_rate_source='legacy_fixed'
where r.source_type='SHOPPING' and r.merchant='COUPANG' and r.purchase_currency='KRW'
  and r.source_txn_key like 'COUPANG:%'
  and r.btc_krw_rate is null and r.btc_rate_at is null and r.btc_rate_source is null
  and exists(select 1 from public.rewards_history h where h.reward_id=r.id and h.event_type='PURCHASE')
  and not exists(select 1 from public.rewards_history h where h.reward_id=r.id
    and h.amount_sats<>sign(h.commission)*floor(abs(h.commission)*0.90))
  and r.purchase_amount=(select greatest(sum(h.gmv),0) from public.rewards_history h where h.reward_id=r.id)
  and r.amount_sats=(select greatest(sum(h.amount_sats),0) from public.rewards_history h where h.reward_id=r.id);

-- No compatibility overload or fixed-rate fallback. RESTRICT fails on dependent objects.
drop function public.sync_coupang_rewards(uuid,jsonb) restrict;
do $$
begin
  if exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='sync_coupang_rewards') then
    raise exception 'Unexpected sync RPC overload; review before applying';
  end if;
end;
$$;

create or replace function public.sync_coupang_rewards(p_admin_id uuid, p_events jsonb,
  p_btc_krw_rate numeric, p_btc_rate_at timestamptz, p_btc_rate_source text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  raw jsonb;
  events jsonb := '[]'::jsonb;
  event_type text;
  event_day date;
  gmv numeric;
  commission numeric;
  sats bigint;
  order_rate numeric;
  rated_events jsonb;
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
  if p_btc_krw_rate is null or p_btc_krw_rate::text in ('NaN','Infinity','-Infinity')
    or p_btc_krw_rate<=0 or p_btc_krw_rate>9007199254740991
    or p_btc_krw_rate<>round(p_btc_krw_rate,2)
    or p_btc_rate_at is null or not isfinite(p_btc_rate_at)
    or p_btc_rate_at < clock_timestamp()-interval '5 minutes'
    or p_btc_rate_at > clock_timestamp()+interval '30 seconds'
    or p_btc_rate_source is distinct from 'upbit' then
    raise exception 'Invalid or stale batch quote' using errcode='22023';
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
    key := event_type||':'||(raw->>'order_id')||':'||(raw->>'product_id')||':'||
      to_char(event_day,'YYYYMMDD')||':'||gmv::text||':'||commission::text;
    events := events || jsonb_build_array(raw || jsonb_build_object('event_key',key));
  end loop;

  -- Serialize manual syncs; each projection/history batch commits or rolls back together.
  perform pg_advisory_xact_lock(20261005,1);
  if p_btc_rate_at < clock_timestamp()-interval '5 minutes' then
    raise exception 'Batch quote expired while waiting for sync lock' using errcode='22023';
  end if;
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
    order_rate := case when v_reward_id is null then p_btc_krw_rate else current_reward.btc_krw_rate end;
    if order_rate is null or order_rate::text in ('NaN','Infinity','-Infinity')
      or order_rate<=0 or order_rate>9007199254740991 then
      raise exception 'Existing reward needs verified rate metadata' using errcode='23514';
    end if;
    if v_reward_id is not null and not (
      (current_reward.btc_rate_source='legacy_fixed' and order_rate=100000000 and current_reward.btc_rate_at is null)
      or (current_reward.btc_rate_source='upbit' and current_reward.btc_rate_at is not null
          and isfinite(current_reward.btc_rate_at))) then
      raise exception 'Existing reward needs verified rate metadata' using errcode='23514';
    end if;
    if v_reward_id is not null and current_reward.btc_rate_source is null then
      raise exception 'Existing reward needs verified rate metadata' using errcode='23514';
    end if;
    rated_events := '[]'::jsonb;
    for raw in select value from jsonb_array_elements(group_events) loop
      -- A duplicate retains its persisted sats; immutable payload checks below still apply.
      select h.amount_sats into sats from public.rewards_history h where h.event_key=raw->>'event_key';
      if not found then
        commission := (raw->>'commission')::numeric;
        sats := (sign(commission)*floor(abs(commission)*0.90*100000000/order_rate))::bigint;
      end if;
      rated_events := rated_events || jsonb_build_array(raw || jsonb_build_object('amount_sats',sats));
    end loop;
    group_events := rated_events;
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
        amount_sats,status,confirm_eligible_at,confirmed_at,created_at,updated_at,btc_krw_rate,btc_rate_at,btc_rate_source)
      values(gen_random_uuid(),member_id,'SHOPPING','COUPANG','COUPANG:'||order_key,net_gmv,'KRW',net_sats,'PENDING',
        (purchase_day+60)::timestamp at time zone 'Asia/Seoul',null,
        purchase_day::timestamp at time zone 'Asia/Seoul',now(),p_btc_krw_rate,p_btc_rate_at,p_btc_rate_source) returning id into v_reward_id;
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
alter function public.sync_coupang_rewards(uuid,jsonb,numeric,timestamptz,text) owner to postgres;
revoke all on function public.sync_coupang_rewards(uuid,jsonb,numeric,timestamptz,text) from public,anon,authenticated;
grant execute on function public.sync_coupang_rewards(uuid,jsonb,numeric,timestamptz,text) to service_role;
notify pgrst, 'reload schema';
commit;
