# BTCBack

Static HTML/CSS and vanilla JavaScript, hosted on GitHub Pages (`btcback.kr`).
Supabase provides Auth, Postgres/RLS and separately deployed Edge Functions.
There is no frontend build step. npm is development/test tooling only.

## Setup and tests

Node.js 22.13 or newer (below 26) is required. Baseline validation uses Node 25.6.0
and npm 11.8.0; other Node versions/OS combinations still require CI verification.
Run from the repository root:

```sh
npm ci
npm run test:browser
npm test
git diff --check
```

If PowerShell blocks `npm.ps1` / `npx.ps1`, use `npm.cmd` / `npx.cmd` instead.
Do not relax machine execution policy. Commit package.json and package-lock.json
together when updating test dependencies.

The exact devDependencies are existing tools: Playwright for browser UI and
PGlite for isolated SQL/RLS tests. No application dependencies or bundler are added.
`npm run test:browser` downloads Playwright's matching Chromium revision (network
and disk space required). Google Chrome is not required. On Linux, missing system
libraries may require `npx playwright install --with-deps chromium` with admin rights.

Optional `CHROME_PATH` selects an existing compatible executable, but is less
reproducible. Leave legacy `PLAYWRIGHT_MODULE` / `PGLITE_MODULE` unset to use the
locked local dependencies. If using `PLAYWRIGHT_BROWSERS_PATH`, keep its value the
same for browser installation and test execution.

`npm test` discovers all `tests/*.test.cjs` and `tests/*.test.mjs`, passes explicit
paths to Node's built-in runner without shell globbing, and limits concurrency to 2.
Failures propagate; no tests are skipped. Individual runs also work:

```sh
node --test tests/signup.test.cjs
```

- Browser: signup, member/session/dashboard, header/copy/layout, admin, reward,
  Coupang CTA and Trip selector/banner behavior.
- SQL: reward/admin RLS, reward sats transitions, membership/consent rules.
- Unit/mock: Coupang reports/deeplink signing, errors and diagnostic scripts.

Automated tests use mocks/fixtures or in-memory PGlite. They require no Supabase
CLI, Docker, production secrets or `.env.coupang`. Screenshots go to OS temporary
storage. SQL tests do not touch Supabase. Real email, deployed JWT behavior, token
refresh and actual purchase/booking attribution require separate approved E2E.

## Secrets and manual diagnostics

`.env`, `.env.*` (except `.env.example`), `*.secret`, `*.secrets`, `node_modules/`
are ignored. Never commit credentials or copy them into fixtures/logs/docs.
Check `git check-ignore .env.coupang`. That file is not loaded by `npm test`.
Only the optional live diagnostics need `COUPANG_ACCESS_KEY`, `COUPANG_SECRET_KEY`
and `COUPANG_TRACKING_CODE`; they make real requests when explicitly run:

```powershell
node --env-file=.env.coupang scripts/test-coupang-deeplink.mjs "https://www.coupang.com/vp/products/8279872054" --with-subid
node --env-file=.env.coupang scripts/diagnose-coupang-deeplink.mjs
```

These scripts retain their own fixed test subId contract, separate from the current
member-channel and legacy timestamp Edge Functions. Review output privately before sharing.

## Deployment contracts (manual only)

Frontend: publish static root files through the existing GitHub Pages setup. Keep
CNAME and public URLs unchanged; no npm build is needed. The actual Pages source
branch/directory is a repository setting and must be confirmed before publishing.

Use `npx supabase ...` from the root; no global CLI installation is required.
The CLI is not needed by tests and is not pinned in this test lockfile. For a
repeatable deployment, approve/record its version and use `npx supabase@<version>`.
No previously verified CLI version is assumed. Existing documented commands:

```powershell
npx supabase functions deploy coupang-deeplink --project-ref YOUR_PROJECT_REF
npx supabase functions deploy coupang-deeplink-no-subid --project-ref YOUR_PROJECT_REF
npx supabase functions deploy coupang-orders --project-ref YOUR_PROJECT_REF
```

| Function | Configuration | Post-deploy check |
| --- | --- | --- |
| coupang-deeplink | Handler verifies JWT, APPROVED profile and valid channel; COUPANG_* secrets and runtime SUPABASE_URL / SUPABASE_ANON_KEY | Authenticated POST with coupangUrl; legacy KST timestamp subId preserved; anonymous/unapproved denial |
| coupang-deeplink-no-subid | Same handler checks; gateway verify_jwt=false does not bypass authentication | Current CTA sends Bearer access_token; server uses Profile channel1 through channel10 |
| coupang-orders | Default JWT verification ON; same secrets; runtime SUPABASE_URL / SUPABASE_ANON_KEY | Unauthenticated/non-admin denial; admin session GET with date range; debug opt-in |

All commands require the intended project ref. Never disable JWT for orders.
Both deeplink handlers require a verified user JWT, an APPROVED Profile and a valid
coupang_sub_id. No durable rate limiter is implemented. Production deployment must
be checked separately; local code/tests do not establish the deployed version.

Hidden TEST A/B remain legacy tests in shopping.html. coupang-attribution.js and
coupang-anchor-test.js send no Authorization header, so valid requests receive 401
after this authorization update, even if the browser is logged in. Their mocked
browser tests do not prove compatibility with the real handler.
The visible CTA uses coupang-no-subid-test.js and sends the existing session token.
Current shopping uses the Profile channel, not the legacy timestamp subId.

See [orders and masked PowerShell calls](supabase/COUPANG_ORDERS.md),
[deeplink authorization and legacy tests](supabase/COUPANG_DEEPLINK.md), and
[operator checks](supabase/COUPANG_MEMBER_ACCESS.md).

## Database and records

Do not edit/re-run applied migrations to refactor history. New DB changes need
new reviewed migrations. Legacy reward/admin SQL has an explicit execution order
outside the CLI migrations directory; do not blindly run db push.

- [Reward/admin setup](supabase/SETUP.md)
- [Membership schema and verification](supabase/MEMBERSHIP_PHASE1.md)
- [Signup/email verification](supabase/SIGNUP_PHASE2A.md)
- [Member session/status and E2E](supabase/MEMBERSHIP_PHASE2B.md)

`supabase/.temp/cli-latest` and `supabase/.temp/linked-project.json` are tracked
CLI-local artifacts, not migration history. They remain unchanged in this phase:
review local link state and explicit project targeting before removing tracking.
No deployment or migration is run by any setup/test command above.
