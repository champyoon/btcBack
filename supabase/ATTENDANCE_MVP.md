# Attendance RPC: manual review required

Migration: `migrations/202609150001_attendance_rpc.sql`.
No frontend, table alteration, new write policy, backfill or production apply.

## Schema status

The repository defines profiles.id as the Auth user UUID, but does not contain
the live rewards/attendances DDL. This implementation uses the supplied intended
schema, tested with isolated fixtures; it is NOT confirmation of live constraints.
Before applying, inspect the live metadata (no row data needed):

```sql
select table_name, column_name, data_type, udt_name, is_nullable, column_default
from information_schema.columns
where table_schema='public' and table_name in ('attendances','rewards')
order by table_name, ordinal_position;

select conrelid::regclass as table_name, conname, pg_get_constraintdef(oid)
from pg_constraint
where conrelid in ('public.attendances'::regclass,'public.rewards'::regclass);

select tablename, indexname, indexdef from pg_indexes
where schemaname='public' and tablename in ('attendances','rewards');

select relname, relrowsecurity, relforcerowsecurity
from pg_class where oid in ('public.attendances'::regclass,'public.rewards'::regclass);
select * from pg_policies
where schemaname='public' and tablename in ('attendances','rewards');
select table_name, grantee, privilege_type from information_schema.role_table_grants
where table_schema='public' and table_name in ('attendances','rewards');
```

Required: immediate non-partial UNIQUE(user_id, attendance_date) and
UNIQUE(source_txn_key), compatible UUID/date/timestamptz columns, nullable
merchant/purchase/eligibility fields and enabled RLS. Client-applicable permissive
write policies, client ownership/BYPASSRLS, or TRUNCATE grants block the migration.
The policy check is deliberately conservative, even if a policy condition or
another restrictive policy would currently deny writes. Inspect any failure;
do not weaken policies or add constraints blindly to make it pass.
The migration does not create missing tables/constraints or change existing RLS.
Review existing triggers and CHECK constraints against the fixed inserted values.

## Contract and security

`public.check_attendance() returns jsonb` takes NO arguments.
Only authenticated has EXECUTE (apart from trusted owner privileges).
It uses auth.uid(), locks that profiles row, and requires APPROVED membership.
Missing UID: SQLSTATE 28000; missing/PENDING/BLOCKED profile: 42501.
Anon is denied function execution. No user/date/amount/status can be submitted.

SECURITY DEFINER is necessary because clients must not write ledger tables
directly. The trusted postgres role owns the function. search_path is empty;
all table/function references are schema-qualified. No client table grants are
added. Existing SELECT policies and admin_users remain unchanged.

Time is captured once from statement_timestamp(), the DB statement start time,
including for a call that waits for a lock. Unlike current_timestamp(), it does
not reuse an earlier transaction start time. Logical day is:

```sql
(execution_time AT TIME ZONE 'Asia/Seoul' - interval '6 hours')::date
```

05:59 KST belongs to the previous day; 06:00 starts the new day, independently
of the connection timezone. The pure helper attendance_logical_date(timestamptz)
is not executable by clients and is never a caller-controlled clock for the RPC.

The deterministic key is `ATTENDANCE:{auth UUID}:{YYYYMMDD}`.
An Attendance INSERT uses ON CONFLICT(user_id, attendance_date) DO NOTHING.
The corresponding reward is always ATTENDANCE / CONFIRMED / 100 sats; merchant,
purchase_amount, purchase_currency and confirm_eligible_at are NULL.
All four creation/confirmation/update timestamps use the captured DB time.

```json
{"success":true,"already_attended":false,"attendance_date":"2026-09-15","reward_sats":100}
```

A consistent existing pair returns the same keys with already_attended=true and
reward_sats=0. Profile row locking serializes this user's concurrent calls;
the two UNIQUE constraints are the final duplicate guards. Any Reward INSERT
failure propagates and rolls back the Attendance INSERT in the same transaction.
Repeatable-read/serializable callers may receive a serialization failure and
must retry their transaction; never reinterpret other constraint errors as success.

## Existing manual data

No existing rows are modified. An old attendance without its matching fixed-key
100-sat confirmed reward returns an integrity error, not a fabricated success.
An orphan reward causes the new Attendance INSERT to roll back on the key conflict.
Manual fixtures dated September 1-14 remain untouched; inspect incompatible keys
or partial pairs manually. This migration intentionally does not repair history.

## Validation and apply

```powershell
node --test tests/attendance-sql.test.cjs
npm test
git diff --check
```

PGlite fixtures test grants/RLS guards, identity/APPROVED checks, first/repeat calls,
12 queued calls, timezone/cutoff/year boundary, rollback, orphan detection and
preservation of existing rows/policies. Only the isolated test function definition
substitutes fixed timestamps; no production test date parameter exists.
PGlite queues one connection, so this does not certify a multi-session stress test.
Docker/PostgreSQL was unavailable locally. Before production apply, run simultaneous
authenticated RPC calls for the same fixture UUID on a disposable PostgreSQL/staging
database and confirm one attendance, one reward, and exactly one 100-sat result.

After schema review and staging verification, execute ONLY the new migration in
Supabase SQL Editor as postgres, or use psql against the intended reviewed database:

```powershell
psql -X -v ON_ERROR_STOP=1 -f supabase/migrations/202609150001_attendance_rpc.sql
```

Configure the connection securely outside the command. Do not run a blanket
`supabase db push` without reviewing every pending migration (including legacy
retirement). No SQL has been applied to production by this task.

References: [PostgreSQL function security](https://www.postgresql.org/docs/current/sql-createfunction.html),
[date/time semantics](https://www.postgresql.org/docs/current/functions-datetime.html),
[ON CONFLICT](https://www.postgresql.org/docs/current/sql-insert.html).
