# Phase 2B: member login and session UX

## Changes

login.html uses the public header/footer and Email + Password only.
member-auth.js serves the ten public page headers and the login/dashboard guards.
member-auth.css styles the login/dashboard status controls. signup.js and its production verification redirect remain
unchanged by Phase 2B (any earlier masking changes are preserved).

Login calls signInWithPassword, then getSession, server getUser and
profiles.select('member_status').eq('id', user.id). No email lookup, Profile
creation or status/tracking mutation. Missing/error/unknown profile fails closed.
Unverified email errors are mapped to an email-confirmation reminder; invalid
credentials share a generic email/password message without existence lookup.

PENDING and BLOCKED remain logged in, with neutral notices in the existing page's
status area. APPROVED on login.html goes to shopping.html. APPROVED on dashboard
reveals the existing DEMO, unchanged. Anonymous dashboard visits go to login.html.
Dashboard starts hidden, including when scripts/CDN fail. It is static demo HTML,
not confidential data; a frontend guard is not a security boundary.

Profile is queried afresh on page entry, retry, session events, returning to a
visible tab and back/forward-cache restore. It is not cached in session metadata.
In-flight checks use a revision number so logout/new checks invalidate old results.
Auth event callbacks defer SDK calls to avoid holding the SDK's Auth lock.

## Session / privacy

The SDK manages persistence and automatic refresh with storageKey
`btcback-member-auth`. No custom JWT/cookie/token storage is implemented.
The default SDK browser storage is localStorage, which can contain the SDK session
(access token, refresh token, expiry, and user object including email). There is
NO additional standalone email/password/profile/status cache. This SDK-managed
session storage must be included in the actual privacy/data-flow review.

No password or token logging. No internal UUID/tracking/email is shown in the UI.
Admin sessionStorage key btcback-admin-auth stays separate. Signup verification
remains memory-only under btcback-signup-verification and does not silently sign
the user into the persistent member client. The user follows the login link.

Logout calls SDK signOut({scope:'local'}), removing/revoking the current member
session and returning to login.html; it does not globally sign out other sessions
or the independent Admin session. Failed logout hides the demo and offers retry
through the logout button; it never falsely reports successful signout.

All public headers use the same final Login/Logout slot. A member session shows
Logout regardless of membership status; no session shows Login. Public header-only
pages do not query Profiles or redirect. Dashboard/login retain the existing guard.
Logout is only in the header; failures on public pages show a generic alert.
Signup's independent verification client and callback processing remain unchanged.

## Authorization and affiliate boundary

shopping.html and its existing affiliate CTA remain PUBLIC for timestamp
attribution regression safety, regardless of member status. Neither Coupang subId
nor Trip.com trip_sub1 uses the member tracking ID. PENDING/BLOCKED UI handling
does NOT enforce an APPROVED-only outbound API. That is deferred to the Affiliate
Attribution phase with server authorization. No real rewards are implemented.

RLS/Edge authorization/DB constraints remain responsible for actual data security.
No migrations, grants or admin_users logic changed. Membership is NOT Admin auth.

## Manual production E2E after review/deployment

1. Verified PENDING test account: open login.html, enter credentials, confirm
   waiting notice and logout access. Confirm no Dashboard demo is revealed.
2. SQL operator changes only that test profile to APPROVED. Refresh login or use
   status retry. Expect shopping.html. Open My BTCBack: expect existing DEMO label.
3. Refresh, navigate away/back, close/reopen browser: SDK session should restore
   (unless browser storage was cleared/denied or session expired). Status is read
   again, not inherited from an old APPROVED metadata value.
4. Operator changes the test account to BLOCKED. Reenter/refresh Dashboard or
   return focus to the tab: demo hides and neutral restriction notice appears.
5. Logout: return to login form. Revisit dashboard.html: redirected to login.
   Also check a second member tab reacts to SDK sign-out events.
6. Wrong email/password: common error; unverified account: verification reminder.
   A missing Profile/network failure must not reveal the demo or create a profile.
7. New signup: real email -> confirmation -> signup.html -> PENDING notice.
   Masked-email signup UX and redirect remain unchanged; then follow login link.
8. Existing Admin login and reward tools still use their independent session.
   Existing public Coupang/Trip.com flows still use KST timestamps.

Automated tests mock the SDK boundary. They verify application state handling,
not actual browser token refresh or production mail/server session lifecycle.
No live production login, status change, or new signup was executed in this phase.

Remaining: password reset, final collection-consent text and safe consent DB
writes, real Affiliate attribution/outbound enforcement, Reward backend/data.
No commit/push or remote DB modifications performed.

References:
- https://supabase.com/docs/reference/javascript/auth-onauthstatechange
- https://supabase.com/docs/guides/auth/signout
- https://supabase.com/docs/guides/auth/sessions
