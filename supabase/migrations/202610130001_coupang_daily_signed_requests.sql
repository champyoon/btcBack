-- MANUAL REVIEW ONLY: see COUPANG_REWARD_DAILY.md BEFORE applying.
-- Standalone replacement for rolled-back 202610050002; do not apply that file afterwards.
-- Verify migration ledger AND actual objects first. This file registers the cron job.
-- Deploy signed-request daily handler first. No net ownership/ACL changes are made.
begin;
set local lock_timeout = '5s';

do $$
begin
  if current_user <> 'postgres' then raise exception 'Apply as postgres'; end if;
  if to_regprocedure('cron.schedule(text,text,text)') is null
    or to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is null
    or to_regprocedure('extensions.hmac(bytea,bytea,text)') is null
    or to_regclass('vault.decrypted_secrets') is null then
    raise exception 'Enable pg_cron, pg_net, Vault and pgcrypto in extensions first';
  end if;
  if coalesce(nullif(current_setting('cron.timezone',true),''),'GMT') not in ('GMT','UTC','Etc/UTC','Etc/GMT') then
    raise exception 'cron.timezone must be UTC/GMT for the 09:00 UTC schedule';
  end if;
  -- service_role is a trusted backend role; preserve its existing Vault privileges.
  if has_table_privilege('anon','vault.decrypted_secrets','SELECT')
    or has_table_privilege('authenticated','vault.decrypted_secrets','SELECT') then
    raise exception 'Review unsafe client Vault read privileges';
  end if;
  if (select count(*) from vault.decrypted_secrets where name='btcback_project_url'
      and decrypted_secret ~ '^https://[a-z0-9-]+\.supabase\.co$') <> 1
    or (select count(*) from vault.decrypted_secrets where name='btcback_coupang_daily_sync_secret'
      and decrypted_secret ~ '^[a-f0-9]{64}$') <> 1 then
    raise exception 'Configure the project URL and 64-hex daily secret in Vault first';
  end if;
end;
$$;

create or replace function public.enqueue_coupang_reward_daily_sync()
returns bigint language plpgsql security definer set search_path = '' as $$
declare
  project_url text;
  daily_secret text;
  request_timestamp text;
  message text;
  signature text;
begin
  select decrypted_secret into strict project_url from vault.decrypted_secrets where name='btcback_project_url';
  select decrypted_secret into strict daily_secret from vault.decrypted_secrets where name='btcback_coupang_daily_sync_secret';
  if coalesce(project_url,'') !~ '^https://[a-z0-9-]+\.supabase\.co$'
    or coalesce(daily_secret,'') !~ '^[a-f0-9]{64}$' then
    raise exception 'Invalid daily sync Vault configuration';
  end if;
  request_timestamp := floor(extract(epoch from clock_timestamp()))::bigint::text;
  message := E'btcback-daily-v1\nPOST\n/functions/v1/coupang-reward-daily\n' || request_timestamp || E'\n{}';
  signature := encode(extensions.hmac(convert_to(message,'UTF8'),decode(daily_secret,'hex'),'sha256'),'hex');
  -- The queue may be readable: never put the reusable secret or an admin JWT here.
  -- This signature authorizes only the empty daily request for five minutes.
  return net.http_post(
    url := project_url || '/functions/v1/coupang-reward-daily',
    headers := jsonb_build_object('Content-Type','application/json',
      'x-btcback-cron-timestamp',request_timestamp,'x-btcback-cron-signature',signature),
    body := '{}'::jsonb, timeout_milliseconds := 180000
  );
end;
$$;
alter function public.enqueue_coupang_reward_daily_sync() owner to postgres;
revoke all on function public.enqueue_coupang_reward_daily_sync() from public,anon,authenticated,service_role;

select cron.schedule('btcback-coupang-reward-daily-sync','0 9 * * *',
  'select public.enqueue_coupang_reward_daily_sync();');
commit;
