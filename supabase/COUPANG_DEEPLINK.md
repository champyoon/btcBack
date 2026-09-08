# Fixed-subId attribution test

Deploy from the repository root:

```powershell
supabase functions deploy coupang-deeplink --project-ref pqlombgqscbacjkudirl --no-verify-jwt
```

This endpoint intentionally has no login and permits browser CORS. It is PUBLIC,
not admin-protected. Collapsing the development UI is not access control. Anyone
can call it and consume the account's Coupang API quota. Limit the test window,
monitor invocation volume, and disable/delete the function after testing. No
durable rate limiter is implemented. Do not expose it as a production service.
JWT verification is disabled for this function only, not coupang-orders.

Existing Secrets required: COUPANG_ACCESS_KEY, COUPANG_SECRET_KEY,
COUPANG_TRACKING_CODE. No values are copied to the frontend. trackingCode is
checked for configuration only and not added to the documented API body.

POST /functions/v1/coupang-deeplink accepts:

```json
{"coupangUrl":"https://www.coupang.com/vp/products/123"}
```

Use a currently available product URL, not the example ID. Only HTTPS
www.coupang.com and coupang.com without credentials/custom ports are accepted.
The server calls POST /v2/providers/affiliate_open_api/apis/openapi/v1/deeplink
with coupangUrls and the fixed body field subId="btcback_test_001". It uses the
same tested HMAC algorithm as the local diagnostic. No additional API parameters.

## Browser test

1. Deploy the function and publish the updated shopping.html and coupang-attribution.js.
2. Expand the development attribution test area at the bottom of shopping.html.
3. Enter a current Coupang product URL and generate the link.
4. Click the generated move button; it uses shortenUrl, never landingUrl.
5. Arrange the intended third-party purchase test according to partner policies.
   Record the test time and product privately. Do not claim reward eligibility.
6. On the next day, after the report refresh, query coupang-orders with the purchase
   date range and debug=true using the existing administrator-only procedure.
7. Look for orders[].subId (or debug[].identifiers.subId) equal to btcback_test_001.
   Also compare date/productId and purchase context. Missing results may reflect
   report delays, attribution conditions or other links; they do not alone prove
   failure. All test clicks share one ID, so it cannot identify individual users.

Successful link generation is not proof of purchase attribution, permission to
use subId for member identification, or approved Bitcoin rewards. No purchase
matching, database changes, automatic rewards or user accounts are added.

```powershell
node --test tests/coupang-deeplink-edge.test.mjs tests/coupang-deeplink.test.mjs tests/coupang-orders.test.mjs
```

These are mocked tests; no purchase or live Coupang request is made by them.
