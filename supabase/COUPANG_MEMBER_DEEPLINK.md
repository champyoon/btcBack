# Member Coupang Deeplink

The existing function name remains `coupang-deeplink-no-subid` for compatibility.
It now requires a Supabase user access token. `verify_jwt = false` remains in the
gateway configuration; the handler verifies the bearer through `/auth/v1/user`
before any Coupang request. A public key alone is not user authentication.

The browser reuses the existing member Auth client through
`BTCBackMember.getSession()`. It sends only `coupangUrl` in the JSON body, with the
session bearer in Authorization. It never reads or supplies the channel or user ID.

The handler uses `SUPABASE_URL` and `SUPABASE_ANON_KEY` plus that same verified user
bearer to SELECT `id,coupang_sub_id` from the user's own profile. No service-role
key is used. Existing own-row RLS and client write restrictions remain unchanged.
Missing profiles, NULL/empty mappings and values outside channel1 through channel10
are rejected with 403. Invalid/missing authentication returns 401. Profile read
failures fail closed. Body/query identity overrides are ignored, with no fallback.

The repository's profiles SELECT grant is table-level and RLS is own-row only.
The manually added `coupang_sub_id` column and live constraints cannot be verified
from repository migrations. No schema migration or mapping updates are included.
Before rollout, verify that the deployed column is selectable under existing RLS,
and users have no UPDATE privilege on the mapping column. Do not broaden RLS to
work around a failed query.

## Rollout and Verification

Redeploy **coupang-deeplink-no-subid** and publish the frontend files together:
`member-auth.js` and `coupang-no-subid-test.js`. Existing Coupang Secrets and
Supabase's built-in URL/anon key are reused. No new credential is needed.
Old unauthenticated frontend requests will be denied after the function update.
Clear browser caches to avoid mixing old and new scripts.

Manually sign in with each mapped account. A single click should return a
shortenUrl and the existing landingUrl containing that account's channel, then
navigate in the same tab. Confirm channel3 for the intended channel3 account.
Do not publish screenshots containing Authorization/access tokens. Test a missing
mapping and a signed-out session: no Coupang link should be generated.

Automated tests mock Auth, profiles, Coupang and navigation. They do not create
production attribution. No deployment or database updates are performed by tests.
