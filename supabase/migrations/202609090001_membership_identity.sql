-- Apply once after the existing reward/admin SQL. No existing objects are replaced.
begin;

create type public.member_status as enum ('PENDING', 'APPROVED', 'BLOCKED');
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null check (length(email) > 0),
  member_status public.member_status not null default 'PENDING',
  tracking_id text not null unique check (tracking_id ~ '^btcb_[0-9a-f]{32}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  approved_at timestamptz,
  blocked_at timestamptz
);

create table public.policy_consents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  policy_type text not null check (policy_type in ('terms', 'privacy_collection')),
  policy_version text not null check (length(btrim(policy_version)) between 1 and 64),
  agreed_at timestamptz not null default now()
);
create index policy_consents_user_history on public.policy_consents (user_id, agreed_at desc);

-- Even privileged profile writes must use verified Auth identity and DB timestamps.
create function public.membership_guard_profile()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  auth_email text;
begin
  select u.email into auth_email from auth.users u
  where u.id = new.id and u.email_confirmed_at is not null;
  if auth_email is null or auth_email = '' then
    raise exception 'Verified email required' using errcode = '23514';
  end if;
  new.email := auth_email;
  if tg_op = 'INSERT' then
    new.member_status := 'PENDING';
    -- Independent UUID v4: 122 random bits, not the Auth user UUID.
    new.tracking_id := 'btcb_' || replace(gen_random_uuid()::text, '-', '');
    new.created_at := now();
    new.approved_at := null;
    new.blocked_at := null;
  else
    if new.id is distinct from old.id or new.tracking_id is distinct from old.tracking_id then
      raise exception 'Identity fields are immutable' using errcode = '23514';
    end if;
    new.created_at := old.created_at;
    new.approved_at := old.approved_at;
    new.blocked_at := old.blocked_at;
    if new.member_status is distinct from old.member_status then
      if new.member_status = 'APPROVED' then new.approved_at := now(); end if;
      if new.member_status = 'BLOCKED' then new.blocked_at := now(); end if;
    end if;
  end if;
  new.updated_at := now();
  return new;
end;
$$;
create trigger membership_profile_guard before insert or update on public.profiles
for each row execute function public.membership_guard_profile();

create function public.membership_sync_verified_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.email_confirmed_at is not null and nullif(new.email, '') is not null then
    insert into public.profiles (id, email) values (new.id, new.email)
    on conflict (id) do update set email = excluded.email
      where public.profiles.email is distinct from excluded.email;
  end if;
  return new;
end;
$$;
create trigger membership_verified_user
after insert or update of email, email_confirmed_at on auth.users
for each row execute function public.membership_sync_verified_user();

revoke all on function public.membership_guard_profile() from public, anon, authenticated;
revoke all on function public.membership_sync_verified_user() from public, anon, authenticated;
alter table public.profiles enable row level security;
alter table public.policy_consents enable row level security;
revoke all on public.profiles, public.policy_consents from public, anon, authenticated;
grant usage on schema public to authenticated;
grant select on public.profiles, public.policy_consents to authenticated;
create policy profiles_read_self on public.profiles for select to authenticated
using (id = (select auth.uid()));
create policy policy_consents_read_self on public.policy_consents for select to authenticated
using (user_id = (select auth.uid()));
-- No client writes, including consent INSERT until Phase 2 defines a trusted path.

-- Existing verified admins receive PENDING profiles, NOT membership approval.
-- Their independent admin_users authorization remains unchanged.
insert into public.profiles (id, email)
select id, email from auth.users
where email_confirmed_at is not null and nullif(email, '') is not null;
commit;
