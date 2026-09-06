-- Run AFTER admin_setup.sql. Preview existing data before running:
select id, store_name, status from public.reward_requests
where store_name is distinct from '쿠팡'
   or status in ('reward_confirmed', 'paid');

begin;
lock table public.reward_requests in access exclusive mode;

alter table public.reward_requests
  add column if not exists reward_sats bigint,
  add column if not exists reward_confirmed_at timestamptz,
  add column if not exists paid_at timestamptz;

-- Abort the whole transaction rather than changing historical purchases/rewards.
do $$
begin
  if exists (select 1 from public.reward_requests where store_name is distinct from '쿠팡') then
    raise exception 'Non-Coupang requests exist. Review original purchases before migrating.';
  end if;
  if exists (select 1 from public.reward_requests where reward_sats < 1) then
    raise exception 'Invalid reward_sats exist. Reconcile historical rewards before migrating.';
  end if;
  if exists (select 1 from public.reward_requests
    where status in ('reward_confirmed', 'paid') and reward_sats is null) then
    raise exception 'Confirmed/paid requests need verified historical reward_sats. See SETUP.md; no amounts or timestamps were invented.';
  end if;
end;
$$;

alter table public.reward_requests
  add constraint reward_requests_sats_positive check (reward_sats is null or reward_sats >= 1),
  add constraint reward_requests_coupang_only check (store_name = '쿠팡'),
  add constraint reward_requests_confirmed_sats_required
    check (status not in ('reward_confirmed', 'paid') or (reward_sats is not null and reward_sats >= 1));

-- Clear both table and existing column grants, then restore the exact API surface.
revoke all privileges on public.reward_requests from public, anon, authenticated;
revoke all privileges (
  id, created_at, store_name, purchase_date, purchase_amount, order_number,
  customer_name, email, lightning_destination, memo, status,
  reward_sats, reward_confirmed_at, paid_at
) on public.reward_requests from public, anon, authenticated;
grant insert (
  store_name, purchase_date, purchase_amount, order_number,
  customer_name, email, lightning_destination, memo
) on public.reward_requests to anon;
grant select on public.reward_requests to authenticated;
grant update (status, reward_sats) on public.reward_requests to authenticated;
-- Existing admin_users-based SELECT/UPDATE RLS and anon INSERT policy are unchanged.

create or replace function public.validate_reward_status_transition()
returns trigger language plpgsql security invoker
set search_path = ''
as $$
begin
  if new.status is distinct from old.status and not (
    new.status = 'rejected'
    or (old.status = 'pending' and new.status = 'purchase_confirmed')
    or (old.status = 'purchase_confirmed' and new.status = 'reward_confirmed')
    or (old.status = 'reward_confirmed' and new.status = 'paid')
  ) then
    raise exception 'Invalid reward status transition' using errcode = '23514';
  end if;

  if new.reward_sats is distinct from old.reward_sats
    and not (old.status = 'purchase_confirmed' and new.status = 'reward_confirmed') then
    raise exception 'reward_sats can only be set during reward confirmation' using errcode = '23514';
  end if;
  if new.status in ('reward_confirmed', 'paid')
    and (new.reward_sats is null or new.reward_sats < 1) then
    raise exception 'A positive reward_sats value is required' using errcode = '23514';
  end if;

  -- Timestamp columns are DB-owned, even if a future grant is accidentally broadened.
  if new.reward_confirmed_at is distinct from old.reward_confirmed_at
    or new.paid_at is distinct from old.paid_at then
    raise exception 'Reward timestamps are database-managed' using errcode = '23514';
  end if;
  if old.status = 'purchase_confirmed' and new.status = 'reward_confirmed' then
    new.reward_confirmed_at := now();
  end if;
  if old.status = 'reward_confirmed' and new.status = 'paid' then
    new.paid_at := now();
  end if;
  return new;
end;
$$;
revoke all on function public.validate_reward_status_transition() from public, anon, authenticated;
drop trigger if exists reward_status_transition on public.reward_requests;
create trigger reward_status_transition
before update on public.reward_requests
for each row execute function public.validate_reward_status_transition();
commit;
