# Phase 2A signup / verification test

## Scope

New signup.html and signup.js only; existing admin-config.js contains public
browser credentials and is loaded without modification. Its ADMIN naming does
not confer admin access. The signup client has separate, memory-only Auth state:
persistSession=false, autoRefreshToken=false, detectSessionInUrl=false.
No localStorage/sessionStorage tokens, password logs, consent writes, Profile
writes, tracking changes or new DB permissions are introduced.

This is a designated Closed Beta test page, not a finalized external signup page.
Terms checkbox is required. The privacy-collection checkbox explicitly confirms
the test notice, not a finalized legal consent. Neither checkbox is persisted.
Final collection/use wording and a trusted consent append path are prerequisites
for opening a production signup flow; no legal text was invented here.

## Flow

signUp sends only email/password and options.emailRedirectTo:
`https://btcback.kr/signup.html`. No user metadata/identity/status is submitted.
Success is deliberately non-enumerating: an existing account may receive an
obfuscated response and no new email. Never infer mail delivery from HTTP success.
Unexpected immediate sessions stop the verification test with a configuration
warning, rather than treating the user as approved or logged in.

This static page uses the SDK implicit flow so an email can be opened in a
different browser without a PKCE verifier. On return it removes the URL fragment,
sets the received session in memory, calls Auth getUser for server verification,
and reads only member_status from the user's Profile. PENDING completion is shown
only after the Auth confirmation and Profile read both succeed. Other states do
not route to another page. Missing/error/expired links never show success.
No separate callback framework or login/logout flow is added. Refreshing the
clean URL shows the signup form again; session continuity is Phase 2B work.

The page uses referrer=no-referrer and does not load affiliate/analytics resources.
Tokens are not printed. Existing public Supabase JS CDN pattern is reused.

## Password settings

Client checks required fields, email validity and matching passwords. It does not
invent minimum length/complexity rules. Supabase validates its configured policy;
weak_password is shown as a safe Korean guidance message. Exact project-specific
minimum length, character requirements and leaked-password settings were not
read/changed in this local implementation. Before testing, inspect Authentication
> Sign In / Providers > Email (Password security) in the Dashboard. Do not weaken
the server policy to match the UI. Rate limits and network failures have separate
safe messages; raw server error text is never rendered.

## Manual E2E after review and deployment

1. Deploy these files after review; no commit/push was performed by this task.
2. Verify Email provider and Confirm email are enabled. URL Configuration should
   have Site URL https://btcback.kr and allow https://btcback.kr/signup.html
   (the configured https://btcback.kr/** also covers it). Check the confirmation
   email template uses Supabase's ConfirmationURL, not a hardcoded home link.
3. Default Supabase SMTP may restrict recipients to project team addresses and
   has rate limits. Use an authorized test mailbox you control. Receiving mail
   remains a manual test; no custom SMTP or settings were changed here.
4. Visit https://btcback.kr/signup.html. Enter a test email/password and matching
   confirmation, read the test notice, check both required UI items, submit once.
5. Before clicking the email, verify in SQL Editor that the Auth row exists with
   NULL email_confirmed_at and its Profile does not exist.
6. Receive the actual email and click its confirmation link. Confirm return to
   btcback.kr/signup.html, token fragment removed, and approval-waiting message.
7. In SQL Editor verify exactly one Profile, matching email/id, PENDING status,
   btcb_ tracking ID and non-null email_confirmed_at. Do not paste token/password
   or personal query results into tickets or logs.
8. Repeat signup with the same email. Do not expect a new email or an explicit
   account-exists message. Check no second Auth/Profile/tracking identity exists.
9. Check expired/used links fail safely and mobile layout. Do not use Admin Auth
   auto-confirm for this test: it would bypass the email delivery being tested.

No live signup/email delivery was performed in this task. Automated tests mock the
SDK boundary and cannot prove deployed templates, SMTP or redirect behavior.

## Remaining Phase 2B

Login page, persistent member sessions, PENDING/APPROVED/BLOCKED routing, logout
and header account controls remain unimplemented. Consent DB write design and
final privacy collection text also remain separate work. No new Affiliate mapping.

## References

- https://supabase.com/docs/guides/auth/passwords
- https://supabase.com/docs/guides/auth/sessions/implicit-flow
- https://supabase.com/docs/reference/javascript/auth-getuser
- https://supabase.com/docs/guides/auth/redirect-urls
