# Coupang Reward Daily Sync: signed requests

## Status and design

Prepared locally only. No production SQL, deployment, cron activation, provider
request or secret access was performed. Production extension version and API
exposure have NOT been independently verified.

pg_cron -> pg_net -> coupang-reward-daily -> existing Reward Sync handler.
Schedule: `0 9 * * *` UTC = 18:00 Asia/Seoul.
The existing dateRange helper computes KST today minus six days through today.
Examples: 20261005 -> 20260929..20261005;
20261103 -> 20261028..20261103; 20270103 -> 20261228..20270103.
Manual admin JWT sync, reward calculation and transaction/idempotency stay unchanged.

## Root cause and exposure

Upstream pg_net SQL grants PUBLIC USAGE on net and ALL on its tables. Its queue
stores outgoing headers. The reported ACL is consistent with this source, but
check the installed extension version before attributing its exact origin.

Revoking anon/authenticated directly does not remove inherited PUBLIC access.
For REVOKE FROM PUBLIC, postgres being a different owner from supabase_admin is
not sufficient to prove the cause: inspect grant options, memberships and SQL
warnings. PostgreSQL permits a non-owner REVOKE to warn and revoke nothing if
grant options are absent. Rollback or later re-grant also needs ruling out.
Do not change extension ownership or assume postgres is a full superuser.

| Path | Assessment |
| --- | --- |
| Direct SQL as anon/authenticated | Reported USAGE + SELECT permits reading queue headers absent another restriction; these roles do not automatically have a remote SQL login. |
| Direct Data API /rest/v1 | Requires exposed schema configuration as well as grants. SELECT alone does not prove HTTP exposure. Keep net and vault unexposed. |
| Public/exposed views or invoker RPC | Can bridge to net using existing reader privileges even if net is not exposed. |
| SECURITY DEFINER RPC | May bridge both queue and Vault using its owner's privileges. Audit EXECUTE permissions, dependencies, bodies and dynamic SQL. |
| DB administrator/service secrets | Privileged compromise is outside this narrow cron fix; Vault is not protection against an authorized decryptor. |

Do not dump queue headers, Vault values, SQL function bodies containing credentials,
or Authorization headers into tickets/logs. Review sensitive code privately.

Supabase recommends pg_cron + pg_net + Vault for scheduling. Vault protects stored
secrets, not copies placed in outgoing HTTP headers. A publishable key in the
documentation example is NOT authorization for privileged Reward Sync.

## Authentication change

The long-term 32-byte key remains only in Vault and Edge Secrets. No raw-key
fallback is accepted. The queue contains only a timestamp and HMAC signature:

This HMAC envelope is BTCBack's application-level authentication, not a claimed
Supabase built-in cron authentication feature. The scheduling infrastructure
remains the official pg_cron/pg_net/Vault pattern.

- x-btcback-cron-timestamp: Unix seconds
- x-btcback-cron-signature: lowercase HMAC-SHA256 hex

Canonical UTF-8 message (LF separators, no trailing LF):

```text
btcback-daily-v1
POST
/functions/v1/coupang-reward-daily
<timestamp>
{}
```

Both implementations decode the 64-hex key to 32 raw bytes.
SQL uses extensions.hmac; Edge uses WebCrypto verify.
The only accepted payload is exactly `{}`, POST, no query parameters.
Signatures expire after 300 seconds; at most 30 seconds future clock skew allowed.
Invalid authentication stops before any provider/DB fetch.
verify_jwt remains false ONLY on the custom-auth daily entry point.
COUPANG_SYNC_ADMIN_ID is rechecked against admin_users by existing handlers/RPC.
Removing its admin membership blocks daily sync. The manual JWT endpoint is unchanged.

Queue-read privileges are no longer a reusable-key disclosure, rather than simply
being ignored. Vault SELECT restrictions for anon/authenticated and enqueue
EXECUTE restrictions remain mandatory.
New migration does not modify net ownership or ACLs.

### Trusted service_role boundary

The migration permits EXISTING service_role Vault USAGE/SELECT privileges; it
neither grants nor revokes them. service_role is a trusted backend role, not a
normal logged-in user. Supabase documents its RLS bypass and backend-only keys.
BYPASSRLS does not itself grant schema/table access: the observed Vault grants
are separate privileges. We do not claim every project has identical grants.

Prerequisites: keep service-role/secret keys only in trusted server environments,
never frontend, repository, logs or queued HTTP headers. Keep vault unexposed in
the Data API. Audit service-role-backed endpoints and SECURITY DEFINER RPCs so
untrusted callers cannot request arbitrary SQL, decrypt secrets or return Vault
data. Normal admin-user JWTs must not be confused with service-role credentials.

A compromised backend/key with a Vault access path can obtain the signing key
and forge daily requests. HMAC and RLS cannot protect against that trusted-role
compromise. Rotate affected backend credentials AND the daily key in both Vault
and Edge if exposed. Backend access remains subject to operational least privilege.
anon/authenticated SELECT (including inherited PUBLIC grants) still aborts the
migration. Direct enqueue EXECUTE remains revoked for service_role as well as
anon/authenticated; this is not a security boundary against a leaked signing key.

## First: confirm migration history (operator only)

Run read-only inspection manually in SQL Editor before applying anything:

```sql
select version from supabase_migrations.schema_migrations
where version in ('202610050001','202610050002','202610130001')
order by version;

select to_regprocedure('public.enqueue_coupang_reward_daily_sync()');
select jobid, jobname, schedule, active, username
from cron.job where jobname='btcback-coupang-reward-daily-sync';

select extname, extversion from pg_extension
where extname in ('pg_net','pg_cron','supabase_vault','pgcrypto');
select current_user, session_user, current_setting('cron.timezone',true);
select rolname, rolsuper, rolinherit from pg_roles
where rolname in ('postgres','supabase_admin','anon','authenticated','service_role');

select c.relowner::regrole as owner, c.relacl,
       a.grantor::regrole as grantor,
       case when a.grantee=0 then 'PUBLIC' else a.grantee::regrole::text end as grantee,
       a.privilege_type, a.is_grantable
from pg_class c cross join lateral aclexplode(c.relacl) a
where c.oid='net.http_request_queue'::regclass;

select r,
  has_schema_privilege(r,'net','USAGE') as net_usage,
  has_table_privilege(r,'net.http_request_queue','SELECT') as queue_select,
  has_table_privilege(r,'net.http_request_queue','SELECT WITH GRANT OPTION') as grant_option,
  has_table_privilege(r,'vault.decrypted_secrets','SELECT') as vault_select
from unnest(array['postgres','anon','authenticated','service_role']) r;

select pg_has_role('postgres','supabase_admin','MEMBER') as owner_membership;
select current_setting('pgrst.db_schemas',true) as possible_exposed_schema_setting;
```

SQL Editor application may not write the CLI migration ledger. Empty ledger
results alone are NOT proof that objects were never created. Cross-check objects,
deployment records and the original failed transaction. Dashboard Data API
settings are authoritative if pgrst.db_schemas is empty.

Audit exposed schemas' views/RPCs, including wrappers that call other functions.
Inventory without printing bodies:
```sql
select n.nspname,p.proname,pg_get_function_identity_arguments(p.oid) as args,
       p.prosecdef,p.proowner::regrole as owner,
       has_function_privilege('anon',p.oid,'EXECUTE') as anon_execute,
       has_function_privilege('authenticated',p.oid,'EXECUTE') as member_execute
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname not in ('pg_catalog','information_schema')
  and (p.prosecdef or p.prosrc ~* '(vault|http_request_queue|execute)');
select schemaname,viewname from pg_views
where definition ~* '(vault|http_request_queue)';
```
This is an inventory, not a complete proof: dynamic SQL, transitive wrappers and
external service credentials require manual review. Block activation until no
untrusted caller can decrypt Vault or invoke privileged enqueue/signing paths.
If extension ACL remediation is needed, ask Supabase support; do not blindly
REVOKE/ALTER OWNER on managed objects.

## Operator rollout (NOT executed by Codex)

1. Complete the audit above. Existing 202610050002 remains untouched because its
   ledger was not available for independent confirmation. New standalone migration:
   `supabase/migrations/202610130001_coupang_daily_signed_requests.sql`.
2. If any old job exists, pause it during the coordinated change. Check its owner
   is postgres and there are no duplicate jobs owned by other roles.
3. Use a unique random 64-lowercase-hex key in Edge COUPANG_DAILY_SYNC_SECRET and
   Vault btcback_coupang_daily_sync_secret. Keep COUPANG_SYNC_ADMIN_ID configured.
   Vault btcback_project_url must be https://pqlombgqscbacjkudirl.supabase.co.
   If a raw secret ever entered the old queue, rotate it in BOTH locations.
   Enter secrets through secure Dashboard inputs; never paste values into repo,
   shell arguments/history, logs or this document.
4. Confirm pgcrypto is enabled in extensions, plus pg_cron/pg_net/Vault.
   Deploy ONLY daily, from the reviewed workspace/config:
   `supabase functions deploy coupang-reward-daily --project-ref pqlombgqscbacjkudirl`
5. Review and execute the NEW migration in SQL Editor as postgres. It registers
   the job immediately, so do this only when activation is approved.
   It replaces an existing enqueue function if present, or creates it if absent.
   Preserve all applied migrations, especially 202610050001.
6. Do NOT run blanket `supabase db push` while 202610050002 is pending: that old
   file still has the raw-header implementation and guard. Do NOT falsely mark it
   applied. Reconcile the pending local migration with the team after confirming
   its history (retire/move the unapplied old file outside migrations under a
   separate reviewed change). Record this SQL Editor application in deployment
   records; align the CLI ledger only with migrations actually applied.
7. Optional operator smoke test after approval:
   `select public.enqueue_coupang_reward_daily_sync();`
   This DOES call the real API and can update rewards after commit. It is not a
   read-only check and was not run here.

Existing Edge daily must be redeployed: it currently expects the raw header.
Orders, cancellations, sync and frontend do not require redeployment for this fix.

## Observability

Dashboard Integrations/Cron -> job runs shows enqueue SQL success/failure.
Dashboard Edge Functions -> coupang-reward-daily -> Logs/Invocations shows actual
HTTP execution. Enqueue success is NOT Reward Sync success.

For a returned request ID, inspect only safe metadata (not headers):
```sql
select id,status_code,timed_out,error_msg,created
from net._http_response where id = <request_id>;
```
Replace the placeholder before running. Responses are temporary (pg_net default
retention is six hours; verify installed settings). Daily logs include range,
success and HTTP status, never signature/key. API/RPC failures stay non-2xx.
No retry or alert system is added.

## Tests and residual risks

Local tests use real PGlite pgcrypto, Node HMAC and Edge WebCrypto with synthetic
keys; pg_cron/pg_net/Vault are stubs. They test readable PUBLIC queue contains no
long-term secret, anon/authenticated cannot read Vault, existing service_role
Vault access survives, all three roles cannot call enqueue, cross-runtime signatures,
bad/expired/future signatures, raw-header rejection, admin revocation, dates,
manual JWT regression, repeated sync no-op and failure propagation.
Run `npm.cmd test` and `git diff --check`.

A copied valid signature CAN be replayed within five minutes. Idempotency prevents
duplicate rewards, but not duplicate API load. No persistent nonce/replay store
or rate limiter was added. Queue writers can disrupt delivery or replay/forward
a valid scoped signature; this is not solved by HMAC. Actual API exposure must be
audited and closed before activation. Expired queued requests fail closed and
need manual retry. Clock drift and worker delays can cause failures.
Database/Edge admins can access the signing key; do not reuse it elsewhere.
A compromised Vault-decrypting RPC defeats this design; the ACL guard cannot
prove absence of every indirect access path. Production assurance remains pending
the operator audit and controlled deployment.

## Primary sources

- [pg_net source and PUBLIC grants](https://raw.githubusercontent.com/supabase/pg_net/master/sql/pg_net.sql)
- [PostgreSQL REVOKE semantics](https://www.postgresql.org/docs/current/sql-revoke.html)
- [Supabase scheduled functions](https://supabase.com/docs/guides/functions/schedule-functions)
- [Supabase exposed schemas](https://supabase.com/docs/guides/api/using-custom-schemas)
- [Supabase backend-only service-role keys](https://supabase.com/docs/guides/database/secure-data)
- [Supabase pg_net](https://supabase.com/docs/guides/database/extensions/pg_net)
