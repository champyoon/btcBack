const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const migration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/202610210001_coupang_reward_live_rate.sql'), 'utf8');

(async () => {
  const db = new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role;
      create table rewards(id uuid primary key default gen_random_uuid(),user_id uuid,source_type text,merchant text,
        source_txn_key text unique,purchase_amount numeric,purchase_currency text,amount_sats bigint,status text,
        confirm_eligible_at timestamptz,confirmed_at timestamptz,created_at timestamptz default now(),updated_at timestamptz default now(),
        cancellation_status text,cancelled_at timestamptz);
      create table rewards_history(reward_id uuid,event_key text unique,event_type text,event_date date,
        product_id text,gmv numeric,commission numeric,amount_sats bigint);
      create table profiles(id uuid,coupang_sub_id text);
      create table admin_users(user_id uuid);
      create function sync_coupang_rewards(uuid,jsonb) returns jsonb language sql as $$ select '{}'::jsonb $$;
      alter table rewards add column btc_krw_rate numeric(20,2),add column btc_rate_at timestamptz,add column btc_rate_source text;
      insert into rewards(source_type,merchant,source_txn_key,purchase_amount,purchase_currency,amount_sats,status)
      values ('SHOPPING','COUPANG','COUPANG:1',10000,'KRW',270,'PENDING'),
        ('SHOPPING','COUPANG','COUPANG:2',10000,'KRW',180,'PENDING'),
        ('SHOPPING','COUPANG','COUPANG:3',10000,'KRW',270,'PENDING'),
        ('ATTENDANCE',null,'ATTENDANCE:1',null,null,100,'CONFIRMED'),
        ('SHOPPING','COUPANG','COUPANG:4',10000,'KRW',270,'PENDING'),
        ('SHOPPING','COUPANG','COUPANG:5',10000,'KRW',999,'PENDING');
      update rewards set btc_krw_rate=150000000,btc_rate_at='2026-10-20T09:00:00Z',btc_rate_source='upbit' where source_txn_key='COUPANG:2';
      update rewards set btc_rate_source='review_needed' where source_txn_key='COUPANG:4';
      insert into rewards_history(reward_id,event_key,event_type,event_date,product_id,gmv,commission,amount_sats)
        select id,source_txn_key,'PURCHASE','2026-09-18','1',10000,300,270 from rewards
        where source_txn_key in ('COUPANG:1','COUPANG:4','COUPANG:5');`);
    const snapshot = async () => (await db.query('select * from rewards order by source_txn_key')).rows;
    const before = await snapshot();
    // Existing column type mismatch fails atomically; no silent conversion.
    await db.exec('alter table rewards alter column btc_krw_rate type numeric(18,2)');
    await assert.rejects(db.exec(migration), /quote column types/);
    await db.exec('rollback;alter table rewards alter column btc_krw_rate type numeric(20,2)');
    assert.deepEqual(await snapshot(), before);
    // RESTRICT preserves a dependent object and rolls back the proposed backfill.
    await db.exec("create view old_sync_dependency as select sync_coupang_rewards(null::uuid,'[]'::jsonb)");
    await assert.rejects(db.exec(migration), /depend/);
    await db.exec('rollback;drop view old_sync_dependency');
    assert.deepEqual(await snapshot(), before);
    await db.exec(migration);
    const after = await snapshot();
    for (let i = 0; i < before.length; i++) {
      const expected = before[i].source_txn_key === 'COUPANG:1'
        ? { ...before[i], btc_krw_rate: '100000000.00', btc_rate_source: 'legacy_fixed' } : before[i];
      assert.deepEqual(after[i], expected);
    }
    assert.equal(after.find(r => r.source_txn_key==='COUPANG:1').btc_rate_at, null);
    assert.equal((await db.query("select to_regprocedure('public.sync_coupang_rewards(uuid,jsonb)') f")).rows[0].f, null);
    const acl = (await db.query(`select prosecdef,proconfig,
      has_function_privilege('anon',oid,'EXECUTE') anon,
      has_function_privilege('authenticated',oid,'EXECUTE') member,
      has_function_privilege('service_role',oid,'EXECUTE') service
      from pg_proc where proname='sync_coupang_rewards'`)).rows;
    assert.equal(acl.length,1); assert.equal(acl[0].prosecdef,true);
    assert.ok(acl[0].proconfig.includes('search_path=""'));
    assert.equal(acl[0].anon,false); assert.equal(acl[0].member,false); assert.equal(acl[0].service,true);
    console.log('PASS quote migration: existing columns/data preserved, evidence-only legacy backfill, unsafe types/dependencies roll back, one secured RPC');
  } finally { await db.close(); }
})().catch(error => { console.error(error); process.exitCode=1; });
