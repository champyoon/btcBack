# Current setup and legacy Reward retirement

The manual purchase-information submission and its admin request dashboard are
retired. reward.html has no form or Supabase client. admin.html retains its
administrator login and admin_users check.

## Administrator access

Existing admin_users, RLS and shared admin-config.js are preserved.
For a NEW installation only, review admin_access.sql; do not rerun it on an
existing installation. It creates the same independent admin access model.

1. Create an administrator in Supabase Authentication > Users.
2. Register that Auth UUID and email in SQL Editor:

```sql
insert into public.admin_users (user_id, email)
values ('REPLACE_WITH_AUTH_USER_UUID', 'REPLACE_WITH_ADMIN_EMAIL');
```

3. Sign in at admin.html. Non-admins must remain denied.
4. Orders/clicks reports use the same admin_users. Keep their JWT verification.
   The public deeplink tests are separate.

No secret/service-role key belongs in the frontend. admin-config.js is shared
by member/admin authentication and must not be removed.

## Retirement migration: manual review only

Review migrations/202609140001_retire_reward_requests.sql.
Deploy the retired UI FIRST, back up old requests, and review dependencies and
pending/paid records before running SQL. This task does not execute migrations.

The migration locks the old table, refuses nonempty data by default, checks
unexpected dependencies, removes named objects, and uses RESTRICT only.
After verifying a backup and deciding how to preserve financial history, change
the local confirmation setting in the migration to 'yes'. No data is copied
to a new ledger automatically. Any failure rolls back the entire migration.

public.rewards and public.attendances are separately managed and untouched.
Their live schemas are not recreated here. Retiring the form does NOT implement
a new automatic Reward pipeline.

Historical reward_requests.sql, admin_setup.sql and reward_sats_migration.sql
remain for historical reference and retirement-test fixtures only.
Do not run them for new installations: use admin_access.sql for fresh admin access.
