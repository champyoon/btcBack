# Coupang cancellation report (read-only)

`coupang-cancellations` verifies the bearer session with Supabase Auth, then
reads `admin_users` under the same user's RLS, matching `coupang-orders`.
No service-role client or DB writes are used. Keep gateway JWT verification
enabled (the Supabase default). Like orders, this endpoint has no browser CORS
support; use an authenticated administrative PowerShell request.

## API and response

Provider endpoint: `GET /v2/providers/affiliate_open_api/apis/openapi/v1/reports/cancels`.
The source is the official cancels documentation supplied for the existing
`scripts/diagnose-coupang-cancels.mjs` and the previously observed live response.
The signed query contains `startDate`, `endDate`, optional `subId`, and `page`.
No undocumented parameters are added. Secrets are the existing
`COUPANG_ACCESS_KEY`, `COUPANG_SECRET_KEY`, `COUPANG_TRACKING_CODE` plus built-in
Supabase URL/anon key. Tracking code is not added to the cancels query.

Dates use the unchanged orders validator: YYYYMMDD, real calendar dates, no
future dates, earliest 20181101, at most 30 calendar days. Omitted dates default
to the latest seven KST calendar days. `debug` accepts true/false.

Pagination starts at 0 and continues while a page has 1000 records, including
an extra empty page for exact multiples. Rows are not deduplicated. Any failed
page fails the entire request without partial data. A 100-page cap and 90-second
request budget fail explicitly rather than report a truncated success.

Success: `{success:true,startDate,endDate,count,cancellations:[...]}`.
Debug adds `{pages:[{page,count}],records:[{index,keys}]}`.
All observed record fields are retained, except credential-like keys/values
are redacted recursively. Numeric `*Id` fields become exact decimal strings;
unsafe IDs fail closed if the runtime lacks JSON reviver source support.
Negative quantities, amounts, commissions and duplicate records are preserved.
Upstream failures return safe error codes, not raw error bodies.

Previously observed fields: `orderDate`, `date`, `trackingCode`, `subId`,
`addtag`, `ctag`, `orderId`, `productId`, `productName`, `quantity`, `gmv`,
`commissionRate`, `commission`, `categoryName`. No missing fields are synthesized.
This change was mock-tested, not deployed or exercised against live Coupang.

## Manual deployment and check

After review only (not executed by this change):

```powershell
supabase functions deploy coupang-cancellations --project-ref YOUR_PROJECT_REF
$projectRef = 'YOUR_PROJECT_REF'
$token = Read-Host 'Admin session access_token' -AsSecureString
$credential = [System.Net.NetworkCredential]::new('', $token)
$headers = @{ Authorization = 'Bearer ' + $credential.Password }
try {
  $result = Invoke-RestMethod -Method Get -Headers $headers -Uri "https://$projectRef.supabase.co/functions/v1/coupang-cancellations?startDate=20260921&endDate=20260921&subId=channel1&debug=true"
  $result.cancellations | Format-Table orderDate,date,orderId,productId,subId,quantity,gmv,commission
  $result.debug.pages | Format-Table
} finally {
  $headers.Clear()
  Remove-Variable credential,token
}
```

## Future history design evidence (no schema changes)

`orderId`, `productId`, `subId`, `trackingCode`, and `orderDate` are useful for
matching the original purchase; `date` is the cancellation report date.
`quantity`, `gmv`, and `commission` preserve the adjustment signs and size.
`addtag`/`ctag` and any new provider fields should remain available for analysis.
These fields are not proven to be a unique cancellation event key. Repeated or
partial cancellations must not be collapsed merely because values match.
