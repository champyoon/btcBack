# Coupang member authorization

Both `coupang-deeplink-no-subid` (current shopping CTA) and
`coupang-deeplink` (legacy timestamp test endpoint) enforce the same server check:

1. Validate the caller's Bearer JWT through Supabase `/auth/v1/user`.
2. Read only that verified UUID's profile using the caller's token and RLS.
3. Require `member_status = APPROVED` and a valid `channel1` through `channel10`.

No request body or query parameter can override identity, approval or channel.
The current endpoint still uses the profile's channel. The legacy endpoint still
uses its original timestamp subId after authorization; it is not a member-channel
tracking endpoint. Old anonymous A/B test callers are intentionally rejected.

Missing/invalid authentication returns 401. Missing/unapproved profiles and invalid
channels return 403 (`coupang_access_unavailable`); approved profiles with null/empty
channels retain `coupang_access_unassigned`. Lookup failures return 5xx. The existing
frontend recognizes the access errors. OPTIONS remains unauthenticated for CORS.
`verify_jwt = false` on the current endpoint does not disable handler authorization.

## Operator deployment, only after review

No migration or frontend change is required for this authorization update.
Deploy both functions to close the legacy anonymous generation path:

```powershell
supabase functions deploy coupang-deeplink-no-subid --project-ref pqlombgqscbacjkudirl
supabase functions deploy coupang-deeplink --project-ref pqlombgqscbacjkudirl
```

Verify approved channel1/channel2 accounts, PENDING/BLOCKED accounts even with a
channel assigned, missing channels, expired/missing JWTs, and preflight in production.
Confirm no Coupang request occurs for denied accounts. Never print JWTs or secrets.
Production gateway settings and actual account flows require operator verification.

This prevents unauthorized new link generation, not reuse of a previously issued
affiliate URL. Existing URLs cannot be revoked by this check. No DB, attribution,
reward calculation or sync behavior is changed.
