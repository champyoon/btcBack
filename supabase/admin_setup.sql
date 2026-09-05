-- Run once AFTER reward_requests.sql. Existing requests are preserved.
begin;

create table public.admin_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  created_at timestamptz not null default now()
);
alter table public.admin_users enable row level security;
revoke all privileges on public.admin_users from public, anon, authenticated;
grant select on public.admin_users to authenticated;
grant usage on schema public to authenticated;

-- Membership is managed only in SQL Editor, never through the public API.
create policy admin_users_read_self on public.admin_users
for select to authenticated
using (user_id = (select auth.uid()));

alter table public.reward_requests
  add constraint reward_requests_status_check
  check (status in ('pending', 'purchase_confirmed', 'reward_confirmed', 'paid', 'rejected'));

alter table public.reward_requests enable row level security;
revoke all privileges on public.reward_requests from public, anon, authenticated;
grant insert (
  store_name, purchase_date, purchase_amount, order_number,
  customer_name, email, lightning_destination, memo
) on public.reward_requests to anon;
grant select on public.reward_requests to authenticated;
grant update (status) on public.reward_requests to authenticated;

-- Recreate only this project's known anonymous policy.
drop policy if exists reward_requests_anon_insert on public.reward_requests;
create policy reward_requests_anon_insert on public.reward_requests
for insert to anon with check (status = 'pending');

create policy reward_requests_admin_select on public.reward_requests
for select to authenticated
using (exists (
  select 1 from public.admin_users where user_id = (select auth.uid())
));

create policy reward_requests_admin_update on public.reward_requests
for update to authenticated
using (exists (
  select 1 from public.admin_users where user_id = (select auth.uid())
))
with check (exists (
  select 1 from public.admin_users where user_id = (select auth.uid())
));

-- Enforce forward transitions even if a client bypasses the UI.
create function public.validate_reward_status_transition()
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
  return new;
end;
$$;
revoke all on function public.validate_reward_status_transition() from public, anon, authenticated;
create trigger reward_status_transition
before update of status on public.reward_requests
for each row execute function public.validate_reward_status_transition();

-- No DELETE grants or policies. Non-admin authenticated users see no rows.
commit;
