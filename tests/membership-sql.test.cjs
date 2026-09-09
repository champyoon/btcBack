const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require(process.env.PGLITE_MODULE || '@electric-sql/pglite');
const a = '11111111-1111-4111-8111-111111111111';
const b = '22222222-2222-4222-8222-222222222222';
const c = '33333333-3333-4333-8333-333333333333';
(async () => {
  const db = new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated; create schema auth;
      create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
      create function auth.uid() returns uuid language sql stable as
      $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      grant usage on schema auth to anon,authenticated;
      insert into auth.users values ('${a}','admin@example.com',now()),('${b}','b@example.com',null);`);
    for (const file of ['reward_requests.sql', 'admin_setup.sql', 'reward_sats_migration.sql',
      'migrations/202609090001_membership_identity.sql']) {
      await db.exec(fs.readFileSync(path.join(__dirname, '..', 'supabase', file), 'utf8'));
    }
    const profile = async id => (await db.query('select * from public.profiles where id=$1', [id])).rows[0];
    assert.equal(await profile(b), undefined);
    assert.equal((await profile(a)).member_status, 'PENDING');
    await db.exec(`update auth.users set email_confirmed_at=now() where id='${b}';
      insert into auth.users values ('${c}','c@example.com',now());`);
    const pb = await profile(b);
    assert.equal(pb.member_status, 'PENDING');
    assert.match(pb.tracking_id, /^btcb_[0-9a-f]{32}$/);
    assert(!pb.tracking_id.includes(b.replaceAll('-', '')));
    assert(!pb.tracking_id.includes('@'));
    assert.equal(new Set((await db.query('select tracking_id from profiles')).rows.map(r => r.tracking_id)).size, 3);
    assert.equal((await db.query("select count(*)::int n from pg_constraint where conrelid='public.profiles'::regclass and contype='u'")).rows[0].n, 1);
    await db.exec(`update auth.users set email='changed@example.com' where id='${b}';
      update auth.users set email_confirmed_at=now() where id='${b}';`);
    assert.equal((await profile(b)).tracking_id, pb.tracking_id);
    assert.equal((await profile(b)).email, 'changed@example.com');
    await db.exec(`update profiles set member_status='APPROVED' where id='${b}'`);
    assert((await profile(b)).approved_at);
    await db.exec(`update profiles set member_status='BLOCKED' where id='${b}'`);
    assert((await profile(b)).blocked_at);
    assert((await profile(b)).approved_at);
    await assert.rejects(db.exec(`update profiles set tracking_id='btcb_00000000000000000000000000000000' where id='${b}'`), { code: '23514' });
    await assert.rejects(db.exec(`update profiles set member_status='INVALID' where id='${b}'`));
    await db.exec(`insert into policy_consents(user_id,policy_type,policy_version) values
      ('${b}','terms','v0.1'),('${c}','privacy_collection','v0.1');
      insert into admin_users(user_id,email) values ('${a}','admin@example.com');`);
    const asRole = async (role, user, fn) => {
      await db.exec(`begin; set local role ${role};`);
      await db.query("select set_config('request.jwt.claim.sub',$1,true)", [user]);
      try { return await fn(); } finally { await db.exec('rollback'); }
    };
    await asRole('authenticated', b, async () => {
      assert.equal((await db.query('select * from profiles')).rows.length, 1);
      assert.equal((await db.query('select id from profiles')).rows[0].id, b);
      assert.equal((await db.query('select * from policy_consents')).rows.length, 1);
      assert.equal((await db.query('select user_id from policy_consents')).rows[0].user_id, b);
      assert.equal((await db.query('select * from admin_users')).rows.length, 0);
      assert.equal((await db.query('select * from reward_requests')).rows.length, 0);
    });
    for (const sql of [
      `insert into profiles(id,email) values ('${b}','fake@example.com')`,
      "update profiles set member_status='APPROVED'", "update profiles set tracking_id='fake'",
      "update profiles set approved_at=now(),blocked_at=now()", "update profiles set email='fake@example.com'",
      'delete from profiles',
      `insert into policy_consents(user_id,policy_type,policy_version) values ('${c}','terms','v0.1')`,
      `insert into policy_consents(user_id,policy_type,policy_version) values ('${b}','terms','v0.1')`,
      "update policy_consents set policy_version='fake'", 'delete from policy_consents',
      'select public.membership_sync_verified_user()', 'select public.membership_guard_profile()'
    ]) await assert.rejects(asRole('authenticated', b, () => db.exec(sql)), { code: '42501' });
    for (const table of ['profiles','policy_consents'])
      await assert.rejects(asRole('anon', '', () => db.exec(`select * from ${table}`)), { code: '42501' });
    await asRole('anon', '', () => db.exec(`insert into reward_requests
      (store_name,purchase_date,purchase_amount,customer_name,email,lightning_destination)
      values ('쿠팡','2026-09-09',1000,'Test','test@example.com','test@wallet.com')`));
    await db.exec(`insert into reward_requests
      (store_name,purchase_date,purchase_amount,customer_name,email,lightning_destination)
      values ('쿠팡','2026-09-09',1000,'Test','test@example.com','test@wallet.com')`);
    await asRole('authenticated', a, async () => {
      assert.equal((await db.query('select * from admin_users')).rows.length, 1);
      assert.equal((await db.query("update reward_requests set status='purchase_confirmed' returning id")).rows.length, 1);
    });
    await db.exec(`delete from auth.users where id='${c}'`);
    assert.equal(await profile(c), undefined);
    assert.equal((await db.query('select * from policy_consents where user_id=$1',[c])).rows.length, 0);
    console.log('PASS verification, backfill, stable random identity, email sync, status timestamps, self-only RLS, denied writes, consent isolation, cascades, existing admin/reward permissions');
  } finally { await db.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
