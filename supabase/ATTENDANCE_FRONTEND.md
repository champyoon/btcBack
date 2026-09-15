# Attendance Frontend

The shared `member-auth.js` client loads `member-attendance.js`. The button is
available after verified Auth and an APPROVED own-profile result on index,
shopping, dashboard, about, login, signup and the four policy pages. Existing
login routing remains unchanged. No second Auth client is created.

Only a deliberate click calls `client.rpc('check_attendance')`, without arguments.
The database decides the date, identity and 100 sats reward. Loading disables the
button. Success opens a native dialog; Confirm navigates to `dashboard.html`.
Already-attended responses show information without a reward amount. Errors stay
on the page and reveal no raw server details. Escape closes without navigation.

## Initial Status

An own-row `rewards` SELECT checks the deterministic
`ATTENDANCE:<auth user UUID>:YYYYMMDD` key, source ATTENDANCE and CONFIRMED status.
It does not read `attendances` or call the mutating RPC on page load. No attendance
state is persisted in browser storage. Refresh and the next daily boundary recheck
the record. A read failure leaves the action available so the RPC can decide.

The lookup day uses KST 06:00 (UTC+3 after subtracting the cutoff), independent of
browser timezone. Browser clock skew can make this preliminary UI state stale;
the click response is authoritative. Strict server-clock-exact status would need
a separate authenticated, own-user read-only RPC returning the database logical
date and completion flag. No such RPC or database change is included here.

## Verification

Run `npm test`. Attendance browser tests intercept every network request and mock
RPC responses; they do not create production rewards. Screenshots are written to
the OS temporary directory at 320, 390, 768 and 1440 pixels.

Before production rollout, confirm the deployed RPC response contract and that
existing own-row rewards SELECT permits `source_txn_key`. Manually test an
APPROVED account: click attendance, confirm +100 sats, open My BTCBack and verify
the expected total (for example 1,400 to 1,500), then reload and verify completed
status. Test a second tab duplicate and PENDING/BLOCKED accounts. A browser with
an incorrect clock may show an available button, but must never bypass RPC rules.

No DB schema, migration, policy, RPC, Dashboard calculation, price service or
affiliate tracking changes are part of this frontend integration.
