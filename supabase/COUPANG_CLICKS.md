# Coupang click-report diagnostic (admin only)

## Observed response, not an assumed schema

On 2026-09-10 a read-only call to the official host succeeded:

`GET https://api-gateway.coupang.com/v2/providers/affiliate_open_api/apis/openapi/v1/reports/clicks`

Query: `startDate=20260908&endDate=20260910&trackingCode=<configured tracking code>`.
HTTP 200, `rCode: "0"`, envelope keys `rCode`, `rMessage`, `data`, seven rows.
All seven rows contained exactly these keys:

| Field | Observed type |
| --- | --- |
| date | string |
| trackingCode | string |
| subId | string |
| addtag | string |
| ctag | string |
| click | number |

No `subParam`, individual click ID, timestamp, target or landing URL field was
present in this sample. This does not prove those fields never occur. The function
returns only present observed fields, without synthesizing missing fields or IDs.
Unknown fields appear by name only in debug mode; their values are not exposed.
Live row values and credentials were not persisted in the repository.

A second read-only probe on 2026-09-10, restricted to 20260909..20260910,
returned HTTP 200, rCode "0", and zero rows. The target subId 260910165746 was
therefore not found at that observation time. This is not proof of no clicks or
failed attribution; recheck after reporting updates. No individual row values
from the earlier sample were printed or saved.

## Security and deployment

Reuses the orders date-range helper and its verified Web Crypto HMAC pattern;
the orders signer hardcodes its path, so the clicks signer uses its own path.
The existing orders/deeplink files are unchanged.

The handler verifies the Supabase access token through `/auth/v1/user`, then checks
`admin_users` with the caller's token and RLS. No service-role key is used. Missing
or invalid sessions receive 401; authenticated non-admins receive 403. No browser
CORS integration is added. Responses use `Cache-Control: no-store`.

Existing secrets: `COUPANG_ACCESS_KEY`, `COUPANG_SECRET_KEY`, `COUPANG_TRACKING_CODE`.
Hosted runtime supplies `SUPABASE_URL`, `SUPABASE_ANON_KEY`. Do not print secrets.

No `supabase/config.toml` override exists in this repository. Match the documented
orders deployment: leave gateway JWT verification enabled, without
`--no-verify-jwt`. Run from the repository root with your authenticated CLI:

```powershell
npx supabase functions deploy coupang-clicks --project-ref pqlombgqscbacjkudirl
```

Deployment was not performed during implementation. This command bundles the
imported orders date helper; it does not redeploy the orders function.

## Windows PowerShell 5.1

Use a current **admin session access_token**, not an anon key or refresh token.
The prompt is masked. Do not paste tokens or report output into public logs.

```powershell
$session = Read-Host 'Admin session access_token' -AsSecureString
$credential = [System.Net.NetworkCredential]::new('', $session)
$headers = @{ Authorization = 'Bearer ' + $credential.Password }
try {
    $uri = 'https://pqlombgqscbacjkudirl.supabase.co/functions/v1/coupang-clicks?startDate=20260909&endDate=20260910&debug=true'
    $result = Invoke-RestMethod -Method Get -Headers $headers -Uri $uri
    $result.clicks | Format-Table date, trackingCode, subId, addtag, ctag, click -AutoSize
    $result.debug | ForEach-Object { $_.keys } | Sort-Object -Unique
    $result.clicks | Where-Object { $_.subId -eq '260910165746' } |
        Format-Table date, subId, click -AutoSize
} finally {
    $headers.Clear()
    Remove-Variable credential, session
}
```

`count` counts report rows, not clicks. Inspect the actual `date`, `subId` and
`click` values together. A matching row is evidence in this report; a missing row
does not establish lost attribution or no clicks. Reports may be incomplete or
delayed, and this implementation does not promise a refresh schedule. Query again
later manually and compare dates with the Partners dashboard and orders report.
The successful schema probe alone does not establish whether the target subId
or a 2026-09-09 purchase was attributed. Do not infer purchases from click counts.

Dates use YYYYMMDD with the same KST defaults as orders (last seven days through
today). Reversed/future/invalid dates and ranges over 30 inclusive days are rejected.
Only startDate, endDate and debug are accepted; duplicate parameters and debug
values other than true/false are rejected. Debug is not sent upstream.

Normal response: `{ startDate, endDate, count, clicks }`.
`debug=true` adds `{ index, keys, identifiers }` for each row; identifiers are only
present trackingCode/subId/addtag/ctag fields. Values are scalar-allowlisted and
credentials are redacted in BOTH normal and debug responses. Error bodies and
exception messages are not echoed or logged. 502 denotes upstream/schema failure,
504 timeout, and 503 missing configuration or unavailable admin check.

```powershell
node --test tests/coupang-clicks.test.mjs
npm.cmd test
```

Tests use synthetic values with the observed field names, not real credentials.
No DB writes, member mappings, reward calculations, frontend changes or background
polling are implemented. This endpoint is temporary diagnostic functionality;
remove/disable it after investigation if no longer needed.
