-- New installations only. Do not recreate existing admin_users.
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

commit;
