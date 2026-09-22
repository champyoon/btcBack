# Coupang Reward Cancellation Design

Status: agreed design; NOT implemented or applied to production.
Before writing a migration, run `inspect_rewards_schema.sql`. The live rewards
DDL is not in this repository. The attendance test fixture has amount_sats > 0,
which would reject a zero effective reward; it is not proof of the live constraint.

## Records to preserve

- Original purchase report and each fetched cancellation report snapshot.
- Provider IDs as text, including trackingCode, orderId and productId.
- User mapping resolved at purchase ingestion; later channel reassignment must
  not transfer ownership of an existing purchase/reward.
- Original commission, original calculated sats, allocation rate 0.90,
  initial BTC/KRW quote, quote source/time, purchase date and product label.
- Latest reconciled cancellation total, effective sats, cancellation date,
  reconciliation result and an audit trail of applied changes.

Keep provider records in dedicated server-managed tables linked to rewards.
Do not put raw affiliate responses in public client-readable reward columns.
Client visibility should be limited to the user's own safe purchase details.

## Reward projection

Use rewards.amount_sats for the current effective amount and preserve the original
amount separately. Proposed metadata belongs in a linked shopping-detail record,
so attendance records need no artificial purchase fields or backfilled values.

- Full cancellation while PENDING: effective sats 0, status CANCELLED; retain row.
- Partial cancellation: retain PENDING, recompute from net commission using the
  original quote and rate. Keep a separate partial-cancellation indicator.
- Zero sats due only to rounding is not evidence of a full cancellation.
- CONFIRMED cancellation: review/adjustment queue; do not silently rewrite an
  already-confirmed reward. Actual payout remains out of scope.
- Purchase + signed cancellation commission must be reconciled in exact decimal
  arithmetic; floor only the final nonnegative sats. Do not convert negative
  cancellations at a new price, and do not round each refund independently.
- Over-cancellation, conflicting IDs, missing original data or incomplete reports
  require review, not a silent clamp or guessed allocation.

## Matching and repeat imports

Observed match candidate: partner account/trackingCode + orderId + productId.
Validate original purchase date (orderDate on cancellation), subId and quantities.
This is not yet a proven globally unique provider key; conflicting purchase rows
must be held for review rather than merged without evidence.

No cancellation event ID has been observed. Store complete, paginated snapshots
for explicit cancellation-date scopes. Preserve identical rows and multiplicity:
a raw-row hash alone must not collapse two genuine identical partial refunds.
Only a fully successful scope fetch can supersede the previous active snapshot.
Failures or partial pages must not erase prior cancellations. Unexpected removal
or alteration of historical cancellations should be held for review.

Recompute cumulative cancellation totals from active snapshots instead of adding
the same fetched negative row every day. Apply the new projection and audit entry
atomically under a per-purchase lock; an unchanged rerun must have no reward effect.
Orders and cancellations must be reconciled before any scheduled confirmation.
The 60-day origin and provider finality criteria still require an explicit decision.

## History UI

Preserve the history row. For a full cancellation show product name, cancellation
date, a cancelled label and 0 sats. Detail may show original pending sats and the
cancellation adjustment. For partial cancellation show the remaining sats and
partial-cancellation label. Original purchase date remains separately available.

Current dashboard already excludes CANCELLED from both PENDING and CONFIRMED
sums and accepts zero amounts. It currently renders merchant and created_at only;
product details/cancellation dates require new metadata and a later UI change.

## Implementation gates

1. Inspect live constraints, policies, grants and triggers without reading rows.
2. Draft a reviewed migration preserving original amounts and own-row access;
   explicitly address any positive-only amount constraint without weakening
   attendance or unrelated reward invariants. No DROP CASCADE or broad grants.
3. Test full/partial/repeated cancellations, duplicate-looking rows, pagination
   failures, quote preservation, rounding, concurrency, ownership and late refunds.
4. Add server reconciliation and safe history metadata rendering together.
5. Apply and deploy only after review; no DB writes or automatic rewards yet.
