# Coupang Reward Sync v1 (manual, historical test policy)

## Scope and prerequisites

New `coupang-reward-sync` calls the existing orders and cancellations handlers
in-process, without changing their authentication, HMAC or provider requests.
Both reports must succeed before any DB write. Only then does a single
`sync_coupang_rewards` PostgreSQL RPC apply the batch atomically.

No scheduler, automatic confirmation, payout, frontend or attendance changes.
No deployment or live DB/API execution was performed for this implementation.

Before manual migration, back up the DB and run `inspect_rewards_schema.sql`.
The live rewards DDL is not stored in this repository. Verify types, grants,
RLS and any triggers. In particular, zero effective sats must be permitted for
fully cancelled SHOPPING rewards. The migration refuses a recognized
`amount_sats > 0` CHECK rather than silently weakening existing constraints.
Other incompatible constraints also require review before production use.
Do not drop a constraint blindly or change attendance invariants.

Review/apply `migrations/202610050001_coupang_reward_sync.sql` manually only.
It adds two nullable rewards columns (`cancellation_status`, `cancelled_at`),
the requested `rewards_history` table with UNIQUE event_key and scoped FK cascade,
a reward_id index, RLS, and a service-only SECURITY DEFINER RPC.
It preserves UNIQUE rewards(source_txn_key). It does not mutate existing rows.
It intentionally fails on repeated application rather than hiding schema drift.

## Authentication and writes

POST requires a current admin user's Supabase access token. The Edge Function
validates it with Auth and checks admin_users under the user's RLS, like orders.
Gateway JWT verification remains enabled by default. Do not deploy with
`--no-verify-jwt`. No browser CORS support is added.

The RPC is executable only by service_role, not authenticated/anon/PUBLIC.
The Edge Function uses built-in `SUPABASE_SERVICE_ROLE_KEY` only for the RPC,
after admin authentication. The RPC also checks/locks the authenticated admin's
admin_users row. Do not expose this server key in a browser or PowerShell caller.
The existing COUPANG_ACCESS_KEY/SECRET_KEY/TRACKING_CODE secrets are reused.

History has no client read/write grants or policies in v1; service_role has
SELECT for operational inspection. The definer RPC writes history/rewards.
Existing rewards/profile/attendance grants and RLS are untouched.

## Rules

- Order-level key: `COUPANG:{orderId}`; member is resolved in SQL through
  profiles.coupang_sub_id. Ambiguous/conflicting mappings abort the batch.
- History key: `{PURCHASE|CANCEL}:{orderId}:{productId}:{YYYYMMDD}:{gmv}:{commission}`.
  Numeric amounts use canonical decimal text (no trailing fractional zeros).
- Each event's sats = PostgreSQL `floor(commission * 0.90)` using exact numeric
  arithmetic. This is the FIXED historical test quote of 100,000,000 KRW/BTC,
  not a live exchange rate. No BTC/KRW price function is called.
- Sum history gmv/sats into rewards. Partial cancellation stays PENDING/PARTIAL.
  Full cancellation (net gmv <= 0 with a CANCEL) clamps gmv/sats to 0 and sets
  CANCELLED/FULL. cancelled_at is latest CANCEL date at KST midnight.
- No CANCEL means cancellation metadata stays NULL. New rewards use earliest
  purchase date at KST midnight for created_at and purchase date + 60 days for
  confirm_eligible_at. Existing eligibility is not overwritten; no confirmation
  scheduler or status upgrade is implemented.
- CONFIRMED rewards and their history are skipped, never modified.
- Missing channel mappings and cancellations without an original purchase are
  skipped with explicit reasons. They can be retried after correcting the scope
  or mapping. Existing ownership is never transferred to another member.
- Existing manual PENDING rewards with no history are adopted ONLY when the
  imported complete purchase baseline matches their purchase_amount and sats.
  Otherwise the batch rolls back; include the original purchase date or review
  the old seed data. No invented balancing event is created.
- Advisory transaction lock serializes manual syncs. Row locks protect updates.
  History UNIQUE prevents duplicate events. An unchanged rerun does not update
  updated_at; actual projection updates explicitly set updated_at=now().

## Manual deployment and calling (after review)

```powershell
supabase functions deploy coupang-reward-sync --project-ref YOUR_PROJECT_REF
$projectRef = 'YOUR_PROJECT_REF'
$token = Read-Host 'Admin session access_token' -AsSecureString
$credential = [System.Net.NetworkCredential]::new('', $token)
$headers = @{ Authorization = 'Bearer ' + $credential.Password }
$body = @{ startDate = '20260918'; endDate = '20260921'; orderId = '8914185084332805' } | ConvertTo-Json
try {
  $uri = "https://$projectRef.supabase.co/functions/v1/coupang-reward-sync"
  $first = Invoke-RestMethod -Method Post -Uri $uri -Headers $headers -ContentType 'application/json' -Body $body
  $first | ConvertTo-Json -Depth 6
  $second = Invoke-RestMethod -Method Post -Uri $uri -Headers $headers -ContentType 'application/json' -Body $body
  $second | ConvertTo-Json -Depth 6
} finally {
  $headers.Clear()
  Remove-Variable credential,token
}
```

`startDate` and `endDate` are required. `orderId` is an optional scope restriction
for the first E2E test; omit it to sync all fetched orders. Client user_id/subId,
event rows, sats and arbitrary other fields are rejected.

Response: `{success:true,startDate,endDate,result:{created_rewards,inserted_events,
duplicate_events,updated_rewards,skipped:[{orderId,reason}]}}`.
On an empty DB the target scope should insert 1 reward and 3 events; the second
call should insert/update zero rows. `skipped` must be reviewed, not ignored.
`sync_database_rejected` returns no sensitive DB error details. Inspect server-side
SQL diagnostics if needed; never print credentials. A transport timeout can occur
after commit; retrying the same scope is safe.

## Verify the real order manually

First verify channel1 uniquely maps to the intended member, no conflicting
legacy reward key exists, and the reward is not CONFIRMED. The test range must
include September 18 purchases AND September 21 cancellation.

```sql
select id, source_txn_key, purchase_amount, amount_sats, status,
       cancellation_status, cancelled_at at time zone 'Asia/Seoul' as cancelled_kst,
       confirm_eligible_at, updated_at
from public.rewards where source_txn_key = 'COUPANG:8914185084332805';

select h.event_key, h.event_type, h.event_date, h.product_id,
       h.gmv, h.commission, h.amount_sats
from public.rewards_history h join public.rewards r on r.id = h.reward_id
where r.source_txn_key = 'COUPANG:8914185084332805'
order by h.event_date, h.event_type, h.product_id;
```

Expected reward: 11900 KRW / 321 sats / PENDING / PARTIAL / 2026-09-21 KST.
Expected history: PURCHASE 13352471 (+13000,+390,+351), PURCHASE 9684698400
(+11900,+357,+321), CANCEL 13352471 (-13000,-390,-351).
Run twice and compare row counts, totals and updated_at. Live E2E still requires
the user's migration review/application and deployment; local tests use provider
mocks and an isolated PGlite PostgreSQL database, not production data.

## Known v1 limitations

- Existing orders handler has no pagination: >=1000 rows fails before writes.
  Narrow the date range. Cancellations reuse full pagination and its limits.
  At most 5000 combined events per call. No partial-page success is applied.
- Deterministic keys deliberately collapse identical rows per the requested MVP.
  They are NOT proven provider-unique cancellation IDs. Identical real partial
  refunds may collapse; changed amounts yield a new key and may double-count.
  Reconciliation/snapshot replacement is not implemented.
- Channel reassignment is not a historical identity map. Keep beta assignments
  stable. Missing/ambiguous ownership must be reviewed, not guessed.
- Floor is per event: +357 -> +321 but -357 -> -322. This follows the requested
  rule and is not symmetric cancellation rounding. Full cancellation clamps to
  zero; a negative remaining sats on a positive net purchase fails for review.
- Provider API freshness and corrections are outside this manual importer.
  No finality guarantee, live quote policy, reward confirmation or payouts.
- PGlite burst tests are serialized, not a multi-connection PostgreSQL race test.

This v1 policy supersedes the earlier conceptual cancellation design's rounding
and snapshot recommendations only for this explicitly scoped implementation.
