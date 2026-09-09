# Membership & Identity Phase 1

## Scope and deployment

This is a DB foundation only. No Auth UI, consent text, affiliate mapping, price
snapshot, or reward behavior has been added. Existing admin_users authorization
is independent of member_status. A PENDING profile does not revoke admin access.

Review and run `migrations/202609090001_membership_identity.sql` once in the
Supabase SQL Editor as the database owner, preferably in a staging project first.
Existing installation order is reward_requests.sql, admin_setup.sql,
reward_sats_migration.sql. Do not rerun those files on an existing installation.
Phase 1B applied this migration to `pqlombgqscbacjkudirl` on 2026-09-09.
Local and remote migration history both contain `202609090001`. Do not rerun it.

The migration uses a transaction and intentionally fails on conflicting existing
object names instead of silently adopting an unknown schema. It does not drop or
replace existing tables, functions, policies, or triggers. Review existing Auth
triggers in the deployed project before running: the repository cannot prove
that its SQL matches live state. The new auth.users trigger requires owner-level
permissions. Trigger failure can fail an Auth confirmation transaction; validate
the complete email flow in staging before production deployment.

This is the first file in supabase/migrations. The older SQL files are manual
installations, not CLI migration history. Do not blindly run `supabase db push`
against a project whose existing migration history has not been reconciled.

## Identity behavior

- auth.users.email_confirmed_at, not user metadata or client storage, gates creation.
- An unconfirmed INSERT creates no profile. A verified INSERT or an UPDATE of
  email/email_confirmed_at creates a profile once verification exists.
- Existing verified users are backfilled as PENDING, including administrators.
  No user receives automatic APPROVED membership or fabricated consent records.
- Repeated confirmations do not reset status, tracking ID, or creation timestamps.
- profiles.email duplicates the authoritative Auth email for self-profile reads
  without exposing auth.users. Auth email updates synchronize it; pending email
  change fields are not copied. This is not a separate editable contact email.
- If an operator manually clears email_confirmed_at later, the existing profile
  is retained, not deleted. Profiles record completed onboarding, not a substitute
  for Auth session validation. Future authorization must check both Auth and
  membership. Do not use client profile flags as proof of verification.
- tracking_id is `btcb_` plus a separately generated UUID v4 without hyphens
  (122 random bits). It is not the Auth UUID or derived from email/time. NOT NULL,
  UNIQUE and a format CHECK apply. An extraordinarily unlikely collision aborts
  the transaction rather than producing duplicate attribution; investigate and
  retry the Auth operation. No custom collision retry loop is added.
- Profile guard sets identity/email/default PENDING and timestamps server-side.
  id/tracking_id are immutable even for ordinary SQL updates by an operator.
- approved_at/blocked_at mean the most recent entry into each respective state;
  they retain historical values on leaving that state. updated_at tracks writes.
  Reapproval updates approved_at. No complex transition state machine is imposed.
- Auth user deletion cascades to their profile and consents. This is relational
  behavior, not a finalized legal retention policy; review retention before launch.

Operators may change status in SQL Editor, using a known user's UUID:

```sql
update public.profiles set member_status = 'APPROVED' where id = 'USER_UUID';
-- Or set member_status = 'BLOCKED'. Do not manually supply timestamp columns.
```

## Tables and permissions

profiles: id (Auth FK/PK), email, member_status enum PENDING/APPROVED/BLOCKED,
tracking_id UNIQUE, created_at, updated_at, approved_at, blocked_at.

policy_consents: UUID id, user_id (profiles FK), policy_type, policy_version,
agreed_at. Types are exactly terms and privacy_collection. The latter refers to
separate collection/use consent, NOT agreement to the public privacy notice.
Version is a nonempty string, e.g. v0.1. A user/date index supports history reads.
Multiple events/versions are possible; no version comparison/reconsent logic.

Both tables enable RLS. authenticated can SELECT only rows matching auth.uid().
anon has no access. Neither role can INSERT/UPDATE/DELETE. In particular no
client can choose another user's consent, self-approve, alter tracking IDs or
erase history. Trigger functions use fixed empty search_path, fully qualified
tables, and revoked public/anon/authenticated EXECUTE permissions.

Consent INSERT is deliberately closed in Phase 1, even for the user's own row.
Phase 2 must define a narrow server/RPC append path that derives user_id from the
authenticated identity, records server time, and validates actual policy/version
and assent. No consent is implied by signup/verification/backfill. Do not grant
broad table writes to work around this. SQL owners remain trusted operators.

## Email verification settings and manual test

1. In Authentication provider settings, enable Email/password and **Confirm email**.
   Do not turn off confirmation to bypass mail limits; auto-confirm or privileged
   manual confirmation is trusted by the DB and will create a profile.
2. Keep Social/OAuth providers disabled for this phase. The DB checks email
   confirmation; provider selection is a Dashboard setting, not a metadata flag.
3. Review Authentication URL Configuration: Site URL and permitted redirect URLs.
   No new callback/login route exists in Phase 1. Use a controlled SDK/API test
   harness in staging, not a new public production UI.
4. Keep the default Supabase email sender for now. Official documentation says it
   sends only to project organization team addresses and has restrictive rate
   limits. Arbitrary third-party beta testers may not receive emails. No custom
   SMTP was configured; do not disable verification as a workaround.
5. Sign up an allowed test email with password via Supabase Auth. Before clicking
   the email link, verify email_confirmed_at is NULL and no matching profile exists.
6. Follow the real verification email, then check exactly one PENDING profile,
   matching Auth email, and one btcb_ ID. Repeat reads/confirmation without reset.
7. Using two real authenticated sessions and the public client key, check self-only
   SELECT and denied INSERT/UPDATE/DELETE for both tables. Never print tokens.
8. Change status through SQL Editor and check timestamps. Verify existing admin
   sign-in/reward management remains operational. Do not test using production
   customers or create fabricated production consent records.

Live email delivery and normal email-change reconfirmation have NOT been tested.
Phase 1B verified deployed triggers and actual Auth transactions through Admin
Auth confirmation and real password sessions (see below). PGlite tests separately
simulate auth.users/auth.uid(); they do not validate mail delivery or GoTrue.

## Data flow for planning review

- Supabase Auth manages auth.users. Email/password authentication involves user
  UUID, email, a password hash (not plaintext), confirmation timestamps, creation/
  update/sign-in timestamps and Auth-managed metadata/token lifecycle fields.
  Phase 1B confirmed these column names in the deployed schema, including
  encrypted_password, email_confirmed_at, confirmation_token, recovery_token,
  email_change, email_change_token_new, raw_user_meta_data and raw_app_meta_data.
  Credential column values were not queried. Test-user email, UUID and confirmation
  timestamps were checked in memory without printing personal identifiers.
  Never copy password hashes or confirmation/recovery tokens into public tables.
- Newly added public personal data: profiles links Auth UUID/email to membership
  status, random tracking ID and lifecycle timestamps. Consents can link user UUID
  to policy type/version/time; no real consent rows are created in this phase.
- Verification emails/tokens and session issuance are managed by Supabase Auth.
  Sessions include access JWT, refresh token, expiry and user information; they
  are credentials, not profile authority. No new browser session code was added.
- Existing admin.js uses signInWithPassword and sessionStorage under
  `btcback-admin-auth`, persistSession=true, autoRefreshToken=true,
  detectSessionInUrl=false. Its existing storage behavior is unchanged.
- Future member browser storage is undecided. Coupang/Trip.com continue their
  KST timestamp attribution; the new random ID is not transmitted to partners.
- Storage country, processors, international transfers, hosting/email processing
  locations and legal retention periods: **확인 필요**. Repository code does not
  establish these facts; inspect project settings/contracts and actual data flow.

## Automated test

```powershell
node --test tests/membership-sql.test.cjs
```

Requires the same PGlite dependency/module override as existing SQL tests.
Run the full existing test suite too; no real API calls are made by these tests.

Official references checked for this implementation:
- https://supabase.com/docs/guides/auth/users
- https://supabase.com/docs/guides/auth/managing-user-data
- https://supabase.com/docs/guides/auth/auth-smtp

## Phase 1B live verification (2026-09-09)

- Confirmed local project ref; refreshed CLI link to the same project. Before
  applying, remote public tables were reward_requests/admin_users. No conflicting
  membership tables/type/functions or custom auth.users trigger were found.
- Remote migration history was empty (legacy SQL installation). Dry-run selected
  only 202609090001_membership_identity.sql. Applied via db push; no reset, repair,
  seeds, role changes or historical migration deletion. Version now matches.
- Confirmed remote tables, enum-backed status, FK/UNIQUE/CHECK constraints, RLS,
  membership triggers and existing admin/reward policies. Existing UI/JS untouched.
- Auth public settings: email=true, mailer_autoconfirm=false, disable_signup=false.
  Settings were read, not changed. Site URL/redirect allowlist were not inspected:
  verify Authentication > URL Configuration in the Dashboard. Confirm Email is
  enabled according to mailer_autoconfirm=false; verify provider settings too.
- Created two unique test-only example.com accounts through Admin Auth with
  email_confirm=false: Auth rows existed, profiles did not. Used Admin Auth
  email_confirm=true: exactly one PENDING profile each, matching email/UUID,
  valid distinct btcb_ IDs, created/updated timestamps, null approved/blocked times.
- Signed in both using password grant. Using actual authenticated JWTs and public
  key through REST: own profile/consent SELECT worked, another user's rows were
  hidden, profile INSERT/DELETE/status/tracking updates were forbidden. Consent
  own/other INSERT, UPDATE and DELETE were forbidden. Anon reads were forbidden.
- Temporary consent fixtures were marked phase1b-test-only and inserted solely by
  SQL owner for isolation testing. They do not represent real assent.
- SQL owner changed only test profiles to APPROVED then BLOCKED; DB timestamps
  populated. Admin Auth email update synced profile email without changing
  tracking ID or BLOCKED state. This does not test normal reconfirmation emails.
- Test Auth users were deleted via Admin Auth. Profile and consent cascades were
  verified. An initial probe account was also deleted before the successful run.
- Important operational detail: service_role has no SELECT grant on the new
  profiles table in this project. The initial service-role REST probe therefore
  failed; SQL owner was used for internal inspection instead. No grants were
  broadened. User RLS conclusions come from real user JWT requests, not SQL owner.
- All 32 automated tests passed again. Existing admin login credentials were not
  used for a live admin login or production reward mutation; that final manual
  smoke check remains. Existing admin/reward policies remain present.
- Membership browser session storage is still unused (no Phase 2 UI). Live test
  tokens/passwords/keys were memory-only. Existing admin sessionStorage unchanged.
- Remaining manual checks: actual verification email receipt/link, email-change
  reconfirmation, Site URL/redirects, and live existing-admin login/reward read.
  No claim of full end-to-end email delivery or production Admin validation.
- Storage country, processors, transfers and retention remain **확인 필요**.
