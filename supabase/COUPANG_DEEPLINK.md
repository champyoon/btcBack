# Coupang deeplink authorization and legacy tests

## Current server contract

Both coupang-deeplink and coupang-deeplink-no-subid require:

1. A Bearer access_token verified through Supabase Auth /auth/v1/user.
2. The verified user's own Profile, read with that token under RLS.
3. member_status = APPROVED.
4. A valid coupang_sub_id: exactly channel1 through channel10.

Client-provided user_id, member status and subId cannot override these checks.
Missing/invalid authentication returns 401; missing/unapproved profiles or invalid
channels return 403. Lookup failures return 5xx. Approved profiles with null/empty
channels retain coupang_access_unassigned. No token or secret is returned.

OPTIONS remains available for CORS. The current function's gateway verify_jwt=false
does not bypass handler authentication. Neither handler is an anonymous link API.
No durable rate limiter is implemented. Verify production deployment separately;
local code is not proof of the deployed version.

## Current and legacy callers

| Caller | Function | Behavior |
| --- | --- | --- |
| Visible CTA: coupang-no-subid-test.js | coupang-deeplink-no-subid | Sends existing session access_token; server uses Profile channel |
| Hidden TEST A: coupang-attribution.js | coupang-deeplink | No JWT; valid requests receive 401 after authorization update |
| Hidden TEST B: coupang-anchor-test.js | coupang-deeplink | No JWT; valid requests receive 401 after authorization update |

TEST A/B remain hidden legacy comparison UI; their scripts are still loaded.
Logging in does not automatically attach a JWT to their fetch requests. Do not
restore anonymous server access to make these tests work. Their browser tests
mock API responses and are not live client/server integration tests.

The legacy coupang-deeplink handler retains KST YYMMDDHHmmss subId generation after
authorization. It validates the Profile channel but does not use it as the outgoing
subId. The current member function uses the Profile channel unchanged.
Earlier fixed btcback_test_001 and manual product URL UI instructions are obsolete.
Local diagnostic scripts have a separate fixed test contract.

## Request and deployment

Both functions accept POST JSON with Authorization: Bearer <access_token>:

```json
{"coupangUrl":"https://www.coupang.com/"}
```

Only HTTPS www.coupang.com and coupang.com URLs without credentials or custom ports
are accepted. Existing Coupang HMAC signing, API parameters and response URL
validation remain unchanged. The visible CTA uses shortenUrl, not landingUrl.

Required environment: COUPANG_ACCESS_KEY, COUPANG_SECRET_KEY, COUPANG_TRACKING_CODE,
and runtime SUPABASE_URL / SUPABASE_ANON_KEY. Never copy secrets or tokens into
frontend code, logs or documentation. trackingCode is not added to the API body.

Manual deployment only, after review:

```powershell
npx supabase functions deploy coupang-deeplink --project-ref pqlombgqscbacjkudirl
npx supabase functions deploy coupang-deeplink-no-subid --project-ref pqlombgqscbacjkudirl
```

Deploy both handlers to close the legacy anonymous path. Do not disable JWT
verification on admin report functions. No DB migration is required.

## Verification

- APPROVED channel1/channel2 users: current CTA succeeds using their own channel.
- PENDING/BLOCKED users, even with a channel: denied before calling Coupang.
- Missing/expired JWT, missing Profile/channel or lookup failure: no link generated.
- Hidden TEST A/B without JWT: 401, not a successful anonymous test.
- OPTIONS/CORS and current CTA error handling remain compatible.

```powershell
node --test tests/coupang-member-access.test.mjs tests/coupang-no-subid-edge.test.mjs tests/coupang-deeplink-edge.test.mjs
```

These are mock tests, not production purchases or live Coupang requests. Existing
member purchase attribution has been user-verified; this authorization change
still requires production account checks after deployment. It does not revoke
previously issued affiliate URLs or change reward calculation or synchronization.
See [COUPANG_MEMBER_ACCESS.md](COUPANG_MEMBER_ACCESS.md) for operator checks.
