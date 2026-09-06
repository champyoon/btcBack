const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require(process.env.PGLITE_MODULE || '@electric-sql/pglite');
const admin = '11111111-1111-4111-8111-111111111111';
const outsider = '22222222-2222-4222-8222-222222222222';
const sql = name => fs.readFileSync(path.join(__dirname, '..', 'supabase', name), 'utf8');
(async () => {
  const db = new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated;
      create schema auth; create table auth.users(id uuid primary key, email text);
      create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
      grant usage on schema auth to anon, authenticated;
      insert into auth.users values ('${admin}','admin@example.com'),('${outsider}','other@example.com');`);
    await db.exec(sql('reward_requests.sql')); await db.exec(sql('admin_setup.sql'));
    await db.exec(`insert into public.admin_users(user_id,email) values ('${admin}','admin@example.com')`);
    const insert = store => `insert into public.reward_requests
      (store_name,purchase_date,purchase_amount,customer_name,email,lightning_destination)
      values ('${store}','2026-01-01',52000,'Test','test@example.com','test@wallet.com')`;
    const id = (await db.query(insert('쿠팡') + ' returning id')).rows[0].id;
    const foreign = (await db.query(insert('Amazon') + ' returning id')).rows[0].id;
    const migration = sql('reward_sats_migration.sql');
    await assert.rejects(db.exec(migration), /Non-Coupang/); await db.exec('rollback');
    const hasColumns = async () => (await db.query("select 1 from information_schema.columns where table_name='reward_requests' and column_name='reward_sats'")).rows.length;
    assert.equal(await hasColumns(), 0);
    assert.equal((await db.query('select count(*)::int n from public.reward_requests')).rows[0].n, 2);
    await db.query('delete from public.reward_requests where id=$1', [foreign]);
    const legacy = (await db.query(insert('쿠팡') + ' returning id')).rows[0].id;
    await db.exec(`update public.reward_requests set status='purchase_confirmed' where id='${legacy}';
      update public.reward_requests set status='reward_confirmed' where id='${legacy}';`);
    await assert.rejects(db.exec(migration), /historical reward_sats/); await db.exec('rollback');
    assert.equal(await hasColumns(), 0);
    // Simulate operator-verified historical data, never invent it in the migration.
    await db.exec(`alter table public.reward_requests add column reward_sats bigint,
      add column reward_confirmed_at timestamptz, add column paid_at timestamptz;
      update public.reward_requests set reward_sats=123,reward_confirmed_at='2026-01-01T12:00:00Z' where id='${legacy}';`);
    await db.exec(migration);
    assert.equal((await db.query('select count(*)::int n from public.reward_requests')).rows[0].n, 2);
    assert.equal((await db.query('select count(*)::int n from public.admin_users')).rows[0].n, 1);
    const history = (await db.query('select reward_sats, reward_confirmed_at from public.reward_requests where id=$1',[legacy])).rows[0];
    assert.equal(Number(history.reward_sats), 123);
    assert.equal(new Date(history.reward_confirmed_at).toISOString(),'2026-01-01T12:00:00.000Z');
    assert.equal((await db.query("select count(*)::int n from pg_trigger where tgrelid='public.reward_requests'::regclass and not tgisinternal")).rows[0].n,1);
    const asRole = async (role, user, fn) => {
      await db.exec(`begin; set local role ${role}`);
      await db.query("select set_config('request.jwt.claim.sub',$1,true)",[user || '']);
      try { return await fn(); } finally { await db.exec('rollback'); }
    };
    const update = set => `update public.reward_requests set ${set} where id='${id}'`;
    const purchaseConfirmed = () => db.exec(update("status='purchase_confirmed'"));
    for (const sats of ['null','0','-1']) {
      await assert.rejects(asRole('authenticated',admin,async()=>{
        await purchaseConfirmed(); await db.exec(update(`status='reward_confirmed', reward_sats=${sats}`));
      }),{code:'23514'});
    }
    await assert.rejects(asRole('authenticated',admin,()=>db.exec(update("status='paid',reward_sats=350"))),{code:'23514'});
    await asRole('authenticated',admin,async()=>{
      await purchaseConfirmed();
      const confirmed = (await db.query(update("status='reward_confirmed',reward_sats=350")+' returning *')).rows[0];
      assert.equal(Number(confirmed.reward_sats),350);
      assert.ok(confirmed.reward_confirmed_at); assert.equal(confirmed.paid_at,null);
      assert.equal(new Date(confirmed.reward_confirmed_at).getTime(),new Date((await db.query('select now() as ts')).rows[0].ts).getTime());
      const paid = (await db.query(update("status='paid'")+' returning *')).rows[0];
      assert.ok(paid.paid_at); assert.equal(Number(paid.reward_sats),350);
      assert.equal(new Date(paid.reward_confirmed_at).getTime(),new Date(confirmed.reward_confirmed_at).getTime());
      const rejected = (await db.query(update("status='rejected'")+' returning *')).rows[0];
      assert.equal(Number(rejected.reward_sats),350); assert.ok(rejected.paid_at);
    });
    await assert.rejects(asRole('authenticated',admin,async()=>{
      await purchaseConfirmed(); await db.exec(update("status='reward_confirmed',reward_sats=350"));
      await db.exec(update('reward_sats=400'));
    }),{code:'23514'});
    await assert.rejects(asRole('authenticated',admin,async()=>{
      await purchaseConfirmed(); await db.exec(update("status='reward_confirmed',reward_sats=350"));
      await db.exec(update("status='paid',reward_sats=null"));
    }),{code:'23514'});
    await assert.rejects(asRole('authenticated',admin,()=>db.exec(update('reward_sats=350'))),{code:'23514'});
    console.log('PASS safe migration rollback, historical data preservation, one trigger, sats validation, DB timestamps, immutability and transitions');
    await asRole('anon',null,()=>db.exec(insert('쿠팡')));
    await assert.rejects(asRole('anon',null,()=>db.exec(insert('Amazon'))),{code:'23514'});
    for (const column of ['reward_sats','reward_confirmed_at','paid_at','status']) {
      const value = column==='reward_sats'?'350':column==='status'?"'pending'":"now()";
      await assert.rejects(asRole('anon',null,()=>db.exec(`insert into public.reward_requests (${column}) values (${value})`)),{code:'42501'});
      await assert.rejects(asRole('anon',null,()=>db.exec(update(`${column}=${value}`))),{code:'42501'});
    }
    await asRole('authenticated',outsider,async()=>{
      assert.equal((await db.query('select * from public.reward_requests')).rows.length,0);
      assert.equal((await db.query(update("status='reward_confirmed',reward_sats=350")+' returning id')).rows.length,0);
    });
    for (const set of ["customer_name='Changed'", "email='changed@example.com'", 'purchase_amount=1', "lightning_destination='changed@wallet.com'", 'reward_confirmed_at=now()', 'paid_at=now()']) {
      await assert.rejects(asRole('authenticated',admin,()=>db.exec(update(set))),{code:'42501'});
    }
    for (const role of ['anon','authenticated']) {
      await assert.rejects(asRole(role,admin,()=>db.exec('delete from public.reward_requests')),{code:'42501'});
    }
    console.log('PASS anon INSERT-only/financial-field denial, non-admin RLS, protected personal data/timestamps, Coupang constraint');
  } finally { await db.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
