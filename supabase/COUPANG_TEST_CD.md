# Attribution TEST C / D

TEST A/B files, signing, timestamp generation and deployed function are unchanged.

## C: no subId

Separate function: `coupang-deeplink-no-subid`. Its handler is a scoped copy of the
existing handler, importing the SAME sign helper. Only the request body loses the
subId property; unused timestamp generation is removed and the diagnostic label
identifies the separate function. Validation, timeout, response and secret
protection stay the same. There is no client-controlled mode in the A/B function.

The frontend uses the B two-click implementation, with separate DOM IDs and
endpoint. First click posts `{ "coupangUrl": "https://www.coupang.com/" }`.
Server sends exactly `{ "coupangUrls": ["https://www.coupang.com/"] }` to the
official API, NOT `subId: ""` or null. On success, the second genuine user click
opens the returned shortenUrl using target=_blank, referrerpolicy=unsafe-url,
rel=noopener. No automatic clicks, window.open or location.assign are used.
The first click alone does not navigate or establish a click-report observation.

Deploy C separately before using it. Like the existing public A/B deeplink
function, this endpoint is intentionally callable from the public test UI:

```powershell
npx supabase functions deploy coupang-deeplink-no-subid --project-ref pqlombgqscbacjkudirl --no-verify-jwt
```

This is NOT the JWT-protected orders/clicks report endpoint. Do not disable JWT
verification on those admin report functions. Existing Coupang secrets are reused.
No deployment, real affiliate click or purchase was performed during this task.

## D: official control

The supplied official anchor/image is unchanged. It navigates directly in one
click, without calling any BTCBack Edge Function. Only wrapper CSS limits the
banner to 728px and preserves its 728:90 ratio on smaller screens.

## Human experiment

1. D-1: click the official banner, then inspect `/reports/clicks` after updates.
2. If D-1 succeeds, D-2: purchase via the official banner, inspect `/reports/orders`.
3. If D succeeds, C-1: prepare and click the no-subId anchor, inspect clicks.
4. If C-1 succeeds, C-2: purchase and inspect orders.

Keep experiments separate to avoid overwriting attribution with another path.
An API success or preserved redirect parameters is not proof of attribution.
No-subId results cannot be matched by the A/B timestamp; compare the report's
actual fields, dates and controlled test records without inventing identifiers.

Tests use mock API/banner responses and do not create live affiliate traffic.
The initial full suite had 44 PASS / 1 FAIL: the pre-existing bitcoin-copy test
expects an older Hero headline. This unrelated copy test and Homepage are not
changed by the C/D task.
