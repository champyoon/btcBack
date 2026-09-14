# BTC/KRW Current Value

Public Edge Function: `btc-krw-price`. No secrets, Auth lookup or database access.
Existing report functions and their authentication settings are unchanged.

- Upbit: `GET https://api.upbit.com/v1/ticker?markets=KRW-BTC`
- Use only `market` and positive numeric `trade_price` from the single ticker.
- Official reference: https://docs.upbit.com/kr/reference/list-tickers
- Response: `{ "success": true, "market": "KRW-BTC", "price": 150000000 }`
- Upstream timeout: 8 seconds. Invalid/HTTP responses: 502; timeout: 504.
- No automatic retries, persistent cache or polling. Upbit limits apply.

The Dashboard reuses the existing CONFIRMED sats total, computes KRW locally,
rounds half-up to an integer won, and displays it as an approximate value.
Zero confirmed sats needs no price request. Price failures affect only this line.
Browser timeout is 10 seconds. Session changes invalidate old price responses.

## Manual deployment (not performed by this change)

From the repository root in PowerShell:

```powershell
supabase functions deploy btc-krw-price --project-ref YOUR_PROJECT_REF
```

`config.toml` disables JWT verification for this public-market-data function only.
Do not change admin report function JWT settings. No SQL migration is needed.
Deploy the function before publishing the updated Dashboard; otherwise positive
balances still show sats/BTC but the Current Value line reports unavailable.

```powershell
Invoke-RestMethod 'https://YOUR_PROJECT_REF.supabase.co/functions/v1/btc-krw-price'
```

Tests use mock Upbit/Edge responses and do not call the production database:

```powershell
node --test tests/btc-krw-price.test.mjs tests/dashboard-rewards.test.cjs
npm test
git diff --check
```
