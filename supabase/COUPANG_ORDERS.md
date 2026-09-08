# Coupang orders diagnostic Edge Function

This function only reads reports. It does not save orders, match reward requests,
calculate rewards, or send Bitcoin. No existing SQL or frontend changes are needed.

## Prerequisites

- A Coupang Partners Open API account with orders-report permission (not seller/WING credentials).
- Existing `admin_users` table/policies from `admin_setup.sql` and a registered Supabase Auth administrator.
- Supabase CLI installed and authenticated. Run commands from the repository root.

## Secrets and deployment

Prefer Dashboard > Edge Functions > Secrets for entering real values without shell history.
Alternatively put the following names and your values in a local `.env.coupang` file:

```dotenv
COUPANG_ACCESS_KEY=REPLACE_LOCALLY
COUPANG_SECRET_KEY=REPLACE_LOCALLY
COUPANG_TRACKING_CODE=REPLACE_LOCALLY
```

Do not commit or share that file. Confirm `git check-ignore .env.coupang` succeeds.
Do not paste keys into HTML, JavaScript, screenshots, chat, or command-line arguments.

```powershell
supabase login
supabase secrets set --env-file .env.coupang --project-ref YOUR_PROJECT_REF
supabase functions deploy coupang-orders --project-ref YOUR_PROJECT_REF
```

Keep the default JWT verification enabled; do not use `--no-verify-jwt`.
The hosted runtime supplies `SUPABASE_URL` and `SUPABASE_ANON_KEY`.
The handler also verifies the session with Auth and checks `admin_users` under
the caller's RLS. A publishable/anon key alone cannot access the report.
No service-role key is used. CORS/browser integration is intentionally not added.

## Test from PowerShell

Sign in with your existing admin account. Use its current Supabase Auth session
`access_token`, not a Coupang key, anon key or refresh token. Enter the token in
the masked prompt below; never print it. This does not require changing admin.js.

```powershell
$projectRef = 'YOUR_PROJECT_REF'
$session = Read-Host 'Admin session access_token' -AsSecureString
$credential = [System.Net.NetworkCredential]::new('', $session)
$headers = @{ Authorization = 'Bearer ' + $credential.Password }
try {
  $result = Invoke-RestMethod -Method Get -Headers $headers -Uri "https://$projectRef.supabase.co/functions/v1/coupang-orders?startDate=20260901&endDate=20260907"
  $result.orders | Format-Table date, orderId, productName, quantity, gmv, commission
} finally {
  $headers.Clear()
  Remove-Variable credential, session
}
```

Use relevant dates for your own report. Both parameters use YYYYMMDD. Omitting
them requests the last seven calendar days through today in Korea; the report
may not yet contain today's data. The diagnostic function limits each request
to 30 inclusive days, rejects invalid/reversed/future dates, and times out each
upstream request after 15 seconds. It does not automatically retry or poll.

Successful JSON contains `startDate`, `endDate`, `count`, and `orders`. Each order
exposes date, trackingCode, subId, orderId, productId, productName, quantity, gmv,
commissionRate, commission and categoryName. Missing fields are null, not invented.
An empty orders array means no rows were returned, not necessarily no purchases.
Treat reports as private. Do not commit output or assume orderId can match a
customer's entered order number without separately validating the API semantics.
JSON numeric IDs beyond JavaScript's safe-integer range require a lossless parser
before this diagnostic implementation is used for production matching.

401: missing/expired session. 403: not an administrator. 400: invalid dates.
503: missing secrets or unavailable membership check. 502: upstream HTTP,
business-code, JSON or schema failure. 504: timeout. Errors intentionally omit
upstream bodies, keys and signatures. Check report access in the Partners portal.

## Verification and references

### Temporary field discovery

Redeploy after updating the handler. Only exact `debug=true` adds a `debug` array;
omitted/false keeps the existing response. Each entry has a zero-based `index`
matching `orders`, `keys` from the raw item's Object.keys(), and `identifiers`
containing only present allowlisted fields. Present null differs from absent.
Object/array values are omitted; known credentials/signatures are redacted.
Unknown fields are listed by name only. No raw items or debug data are logged.
Administrator authentication remains required; debug is not sent to Coupang.

```powershell
supabase functions deploy coupang-orders --project-ref YOUR_PROJECT_REF
$projectRef = 'YOUR_PROJECT_REF'
$session = Read-Host 'Admin session access_token' -AsSecureString
$credential = [System.Net.NetworkCredential]::new('', $session)
$headers = @{ Authorization = 'Bearer ' + $credential.Password }
try {
  $uri = "https://$projectRef.supabase.co/functions/v1/coupang-orders?startDate=20260901&endDate=20260907&debug=true"
  $result = Invoke-RestMethod -Method Get -Headers $headers -Uri $uri
  # Field names observed across the returned orders, without identifier values:
  $result.debug | ForEach-Object { $_.keys } | Sort-Object -Unique
  # Per-item keys and allowlisted identifiers (private report data):
  $result.debug | ConvertTo-Json -Depth 5
} finally {
  $headers.Clear()
  Remove-Variable credential, session
}
```

No live response has been examined as part of implementation. Empty results cannot
establish whether a field exists; use a date range containing orders. Presence in
one report does not establish universal availability or customer-order matching.
Treat identifiers as private and do not publish/commit output. Use `debug=false`
or omit debug after inspection. Existing JSON numeric-ID precision limits apply.

```powershell
node --test tests/coupang-orders.test.mjs
```

Tests use fixtures, not live credentials. Live deployment and report permissions
must be checked separately. Expected report envelope: `{ rCode: '0', data: [] }`.
The Partners portal's JavaScript-only orders reference could not be inspected
in this implementation environment; confirm endpoint parameters/envelope against
your account's current Open API documentation when testing.

- [Official Coupang HMAC specification](https://partner-developers.coupangcorp.com/hc/en-us/articles/360053719371-Create-HMAC-Signature)
- [Partners Open API portal](https://partners.coupang.com/#help/open-api)
- [Supabase secrets](https://supabase.com/docs/guides/functions/secrets)
- [Supabase function authentication](https://supabase.com/docs/guides/functions/auth)
