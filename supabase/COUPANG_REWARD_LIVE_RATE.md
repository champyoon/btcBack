# Coupang Reward live BTC/KRW quote rollout

Local implementation only. No production SQL, live quote/provider call, deployment,
cron change or commit/push has been performed. Review and approval are required.

## Behavior

The existing manual JWT and signed Daily paths converge on the Sync handler.
After both provider reports are validated, Sync fetches Upbit KRW-BTC once, then
passes one quote to a single atomic database RPC. No caller-supplied rate is accepted
by the HTTP endpoint. Even an empty/repeated batch requires a valid current quote.
There is no cached/fixed fallback. Failure returns safe `reward_price_unavailable`
with HTTP 502 before any RPC write.

New orders use the batch quote; existing orders use their stored quote, including
late new product rows and cancellations. Duplicate events reuse persisted history
sats, with the existing immutable payload/ownership checks still enforced.
The projection is still SUM(history); CONFIRMED rows remain untouched. Event keys,
locks, admin checks, 90% allocation, cancellation status and transaction rollback
remain in place. No new cancellation matching/reconciliation features are added.

Per-event exact PostgreSQL numeric calculation:

`sign(commission) * floor(abs(commission) * 0.90 * 100000000 / order_rate)`

Example: 300 KRW commission at 150000000 KRW/BTC -> 180 sats; -300 -> -180.
Rounding is per event, NOT after summing an order.

## Quote meaning and freshness

The shared helper reads Upbit `trade_price` and `timestamp` from the fixed HTTPS
KRW-BTC endpoint. `btc_rate_at` is the ticker information update timestamp (UTC
milliseconds converted to timestamptz), NOT local fetch time or `trade_timestamp`.
`btc_rate_source` is `upbit`. Actual fetch completion time is used only to check
freshness; it is not stored as a fabricated exchange timestamp.

Allowed age: at most 300 seconds, with at most 30 seconds future clock skew.
Missing/invalid timestamps, nonpositive/nonfinite prices and prices with more
than two decimal places fail closed. SQL independently validates the batch quote
and rechecks age after the advisory lock. No current-age check applies to an
existing order's historical quote. Daily's frozen date-range clock is NOT reused
for quote freshness; delayed report fetching still uses actual fetch time.

The public Dashboard price handler reuses basic fetch/price validation and keeps
its original response contract. Dashboard current-value calculations are unchanged.

Official field definitions: https://docs.upbit.com/kr/reference/list-tickers
The five-minute/30-second limits are BTCBack implementation choices, not Upbit guarantees.

## Migration and RPC contract

New file: `migrations/202610210001_coupang_reward_live_rate.sql`.
Already-applied migrations are unchanged.

- Adds the three columns IF NOT EXISTS and verifies their actual types.
- Never changes existing sats, non-null quote metadata or historical quote times.
- Backfills only all-null metadata for Coupang SHOPPING/KRW rows whose complete
  history matches the old fixed-rate formula AND their current projection.
  Sets 100000000 / legacy_fixed, leaving rate_at NULL.
- History-less manual seeds, mismatched projections and partially populated
  metadata are NOT guessed/backfilled. Review them before enabling sync; missing
  or inconsistent saved quote metadata blocks an affected non-CONFIRMED batch.
  A verified legacy manual seed must have 100000000 / legacy_fixed / NULL before
  its complete purchase baseline can be adopted by the unchanged baseline check.
- Drops the old two-argument function with RESTRICT, not CASCADE. Dependencies or
  unexpected overloads stop the transaction, including rollback of the backfill.
- Installs exactly one five-argument RPC, SECURITY DEFINER, empty search_path,
  owner postgres, EXECUTE only service_role (not PUBLIC/anon/authenticated).
- Sends a PostgREST schema reload notification on commit.

New RPC arguments (all required; no default fallback/compatibility overload):

```text
p_admin_id uuid
p_events jsonb
p_btc_krw_rate numeric
p_btc_rate_at timestamptz
p_btc_rate_source text
```

The HTTP manual contract remains `{startDate,endDate,orderId?}`. Old Edge code
cannot call the new RPC and new Edge code cannot call the old RPC: a coordinated
maintenance window is necessary. No silent fixed-rate compatibility path exists.

## Operator deployment order (instructions only)

1. Back up data and verify actual live RPC, columns, defaults, constraints, triggers
   and grants. Confirm no other application writes this RPC/history. Review
   all-null/partial metadata and history-less seeds rather than inventing rates.
   Compare migration ledger and deployed objects; do not replay old migrations.
2. During an approved window, pause the existing cron job without changing its
   schedule and stop manual sync requests. Wait for in-flight runs to finish.
3. Apply ONLY the new migration after review. If a dependency/type guard fails,
   investigate instead of using CASCADE or bypassing the guard.
4. Deploy BOTH entry points: Daily bundles the Sync handler in-process, so
   deploying only the manual Sync function is insufficient:

```powershell
supabase functions deploy coupang-reward-sync --project-ref pqlombgqscbacjkudirl
supabase functions deploy coupang-reward-daily --project-ref pqlombgqscbacjkudirl
```

   Do not alter verify_jwt, HMAC keys, Cron SQL or admin configuration.
   `btc-krw-price` may be deployed with the shared-helper refactor as well, but
   its deployed HTTP contract is unchanged and Reward Sync does not call it over HTTP.
5. Confirm PostgREST sees only the new signature and its named arguments. In an
   authorized small manual sync, check new order sats/quote, an old order's saved
   quote, and repeat no-op. This is a REAL write; not performed by local tests.
6. Resume the existing 18:00 KST cron and inspect Daily logs/HTTP status. Do not
   treat pg_net enqueue success as proof of successful Reward Sync.

Do not roll back only the Edge code after the RPC switch. Pause sync and prepare
a reviewed coordinated rollback; never recompute live-rate orders at the old rate.

## Verification and limitations

Run `npm.cmd test` and `git diff --check` locally. Tests use mock provider responses
and PGlite SQL, not real Upbit/Coupang/Supabase calls. They cover new/mixed batches,
one quote per batch, changed-rate replay, late products, legacy baseline adoption,
positive/negative symmetric rounding, partial/full cancellation, quote failures,
freshness, migration preservation/rollback/ACL and Daily/manual authentication.

PostgREST routing itself is not emulated by PGlite: tests validate the exact named
payload and sole SQL signature, but deployed schema-cache refresh is still an
operator verification step. Multi-connection production races are not simulated.
Existing event-key collision/partial-refund rounding limitations remain; split
refunds can differ from one combined refund due to per-event floor. Missing
purchase history and CONFIRMED cancellations retain existing behavior.
Freshness limits do not detect an exchange serving an incorrect but fresh price.
No price-source fallback, retry, scheduler or payout functionality is added.
