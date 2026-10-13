const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const { pgcrypto } = require('@electric-sql/pglite/contrib/pgcrypto');
const { createHmac } = require('node:crypto');
const migration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/202610130001_coupang_daily_signed_requests.sql'), 'utf8');

(async () => {
  const db = new PGlite({ extensions: { pgcrypto } });
  try {
    // Local SQL stubs only: no pg_cron worker, HTTP request or live Vault is installed/executed.
    await db.exec(`create schema extensions;create extension pgcrypto with schema extensions;
      create role anon;create role authenticated;create role service_role;
      create schema cron;create schema net;create schema vault;
      create table cron.job(jobid bigserial primary key,jobname text unique,schedule text,command text);
      create function cron.schedule(text,text,text) returns bigint language sql as $$
        insert into cron.job(jobname,schedule,command) values($1,$2,$3) returning jobid $$;
      create table vault.decrypted_secrets(name text unique,decrypted_secret text);
      create table net.http_request_queue(id bigserial primary key,url text,headers jsonb,body jsonb,timeout_milliseconds integer);
      create function net.http_post(url text,body jsonb default '{}',params jsonb default '{}',headers jsonb default '{}',timeout_milliseconds integer default 2000)
        returns bigint language sql as $$
          insert into net.http_request_queue(url,headers,body,timeout_milliseconds) values($1,$4,$2,$5) returning id $$;
      create table public.rewards(marker text); insert into rewards values('unchanged');
      create table public.rewards_history(marker text); insert into rewards_history values('unchanged');`);
    // Reproduce upstream PUBLIC queue privileges, without exposing the signing key.
    await db.exec('grant usage on schema net to public; grant all on net.http_request_queue to public');
    await assert.rejects(db.exec(migration), /Configure the project URL/);
    await db.exec('rollback');
    assert.equal((await db.query("select to_regprocedure('public.enqueue_coupang_reward_daily_sync()') f")).rows[0].f, null);
    await db.query('insert into vault.decrypted_secrets values($1,$2),($3,$4)',
      ['btcback_project_url', 'https://mock.supabase.co', 'btcback_coupang_daily_sync_secret', 'a'.repeat(64)]);
    await db.exec('grant usage on schema vault to service_role; grant select on vault.decrypted_secrets to service_role');
    for (const role of ['anon', 'authenticated', 'public']) {
      await db.exec(`grant select on vault.decrypted_secrets to ${role}`);
      await assert.rejects(db.exec(migration), /unsafe client Vault/);
      await db.exec(`rollback;revoke select on vault.decrypted_secrets from ${role}`);
    }
    await db.exec("set cron.timezone='Asia/Seoul'");
    await assert.rejects(db.exec(migration), /cron.timezone must/);
    await db.exec("rollback;set cron.timezone='GMT'");
    await db.exec(migration);
    const jobs = (await db.query('select jobname,schedule,command from cron.job')).rows;
    assert.deepEqual(jobs, [{ jobname: 'btcback-coupang-reward-daily-sync', schedule: '0 9 * * *',
      command: 'select public.enqueue_coupang_reward_daily_sync();' }]);
    assert.ok(!jobs[0].command.includes('a'.repeat(64)));
    assert.equal((await db.query('select count(*)::int n from net.http_request_queue')).rows[0].n, 0);
    await db.query('select public.enqueue_coupang_reward_daily_sync()');
    const request = (await db.query('select * from net.http_request_queue')).rows[0];
    assert.equal(request.url, 'https://mock.supabase.co/functions/v1/coupang-reward-daily');
    assert.equal(request.headers['x-btcback-cron-secret'], undefined);
    assert.ok(!JSON.stringify(request).includes('a'.repeat(64)));
    const timestamp = request.headers['x-btcback-cron-timestamp'];
    assert.equal(request.headers['x-btcback-cron-signature'], createHmac('sha256', Buffer.from('a'.repeat(64),'hex'))
      .update(`btcback-daily-v1\nPOST\n/functions/v1/coupang-reward-daily\n${timestamp}\n{}`).digest('hex'));
    assert.deepEqual(request.body, {});
    assert.equal(request.timeout_milliseconds, 180000);
    for (const role of ['anon', 'authenticated', 'service_role']) {
      await db.exec(`set role ${role}`);
      await assert.rejects(db.query('select public.enqueue_coupang_reward_daily_sync()'), { code: '42501' });
      if (role === 'service_role') {
        assert.equal((await db.query('select count(*)::int n from vault.decrypted_secrets')).rows[0].n, 2);
      } else {
        await assert.rejects(db.query('select decrypted_secret from vault.decrypted_secrets'), { code: '42501' });
      }
      const visible = (await db.query('select headers from net.http_request_queue')).rows;
      assert.ok(!JSON.stringify(visible).includes('a'.repeat(64)));
      await db.exec('reset role');
    }
    await db.exec("update vault.decrypted_secrets set decrypted_secret='https://attacker.example' where name='btcback_project_url'");
    await assert.rejects(db.query('select public.enqueue_coupang_reward_daily_sync()'), /Invalid daily sync/);
    assert.equal((await db.query('select count(*)::int n from net.http_request_queue')).rows[0].n, 1);
    assert.deepEqual((await db.query('select * from rewards')).rows, [{ marker: 'unchanged' }]);
    assert.deepEqual((await db.query('select * from rewards_history')).rows, [{ marker: 'unchanged' }]);
    console.log('PASS daily SQL: 09:00 UTC, one scoped job, Vault-only credentials, owner-only enqueue, prerequisites and unsafe configuration rejection');
  } finally { await db.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
