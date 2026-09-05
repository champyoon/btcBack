const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require(process.env.PGLITE_MODULE || '@electric-sql/pglite');
const admin = '11111111-1111-4111-8111-111111111111';
const outsider = '22222222-2222-4222-8222-222222222222';
(async () => {
  const db = new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated;
      create schema auth; create table auth.users (id uuid primary key, email text);
      create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
      grant usage on schema auth to anon, authenticated;
      insert into auth.users values ('${admin}', 'admin@example.com'), ('${outsider}', 'other@example.com');`);
    for (const file of ['reward_requests.sql', 'admin_setup.sql']) await db.exec(fs.readFileSync(path.join(__dirname, '..', 'supabase', file), 'utf8'));
    await db.query('insert into public.admin_users (user_id, email) values ($1,$2)', [admin, 'admin@example.com']);
    const asRole = async (role, user, fn) => {
      await db.exec(`begin; set local role ${role};`);
      await db.query("select set_config('request.jwt.claim.sub', $1, true)", [user || '']);
      try { return await fn(); } finally { await db.exec('rollback'); }
    };
    const insert = `insert into public.reward_requests (store_name,purchase_date,purchase_amount,customer_name,email,lightning_destination)
      values ('Test','2026-01-01',52000,'Test','test@example.com','test@wallet.com')`;
    await asRole('anon', null, () => db.exec(insert));
    for (const sql of [
      'select * from public.reward_requests',
      "update public.reward_requests set status='rejected'",
      'delete from public.reward_requests',
      `insert into public.admin_users (user_id,email) values ('${outsider}','other@example.com')`,
      "insert into public.reward_requests (status) values ('paid')"
    ]) await assert.rejects(asRole('anon', null, () => db.exec(sql)), { code: '42501' });
    await db.exec(insert);
    console.log('PASS anon insert only; no reads, writes, membership escalation or status injection');
    await asRole('authenticated', outsider, async () => {
      assert.equal((await db.query('select * from public.reward_requests')).rows.length, 0);
      assert.equal((await db.query('select * from public.admin_users')).rows.length, 0);
      assert.equal((await db.query("update public.reward_requests set status='rejected' returning id")).rows.length, 0);
    });
    await assert.rejects(asRole('authenticated', outsider, () => db.exec(`insert into public.admin_users (user_id,email) values ('${outsider}','other@example.com')`)), { code: '42501' });
    await asRole('authenticated', admin, async () => {
      assert.equal((await db.query('select * from public.reward_requests')).rows.length, 1);
      assert.equal((await db.query('select * from public.admin_users')).rows.length, 1);
      for (const status of ['purchase_confirmed', 'reward_confirmed', 'paid', 'rejected']) {
        const updated = await db.query('update public.reward_requests set status=$1 returning id,status', [status]);
        assert.equal(updated.rows[0].status, status);
      }
    });
    for (const sql of ["update public.reward_requests set email='changed@example.com'", 'delete from public.reward_requests', 'delete from public.admin_users']) {
      await assert.rejects(asRole('authenticated', admin, () => db.exec(sql)), { code: '42501' });
    }
    for (const sql of ["update public.reward_requests set status='paid'", "update public.reward_requests set status='invalid'"]) {
      await assert.rejects(asRole('authenticated', admin, () => db.exec(sql)), { code: '23514' });
    }
    await db.exec(`delete from public.admin_users where user_id='${admin}'`);
    await asRole('authenticated', admin, async () => assert.equal((await db.query('select * from public.reward_requests')).rows.length, 0));
    console.log('PASS admin membership RLS, status-only updates, forward transitions, revocation');
  } finally { await db.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
