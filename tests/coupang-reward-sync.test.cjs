const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const migration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/202610050001_coupang_reward_sync.sql'), 'utf8');
const admin = '11111111-1111-4111-8111-111111111111';
const member = '22222222-2222-4222-8222-222222222222';
const other = '33333333-3333-4333-8333-333333333333';
const order = '8914185084332805';
const purchase = [
  { orderId: order, productId: '13352471', date: '20260918', subId: 'channel1', gmv: 13000, commission: 390 },
  { orderId: order, productId: '9684698400', date: '20260918', subId: 'channel1', gmv: 11900, commission: 357 },
];
const cancellation = { ...purchase[0], orderDate: '20260918', date: '20260921', gmv: -13000, commission: -390 };

(async () => {
  const { createHandler, normalize } = await import('../supabase/functions/coupang-reward-sync/handler.mjs');
  const db = new PGlite();
  try {
    // Isolated schema fixture, not an export of the live database.
    await db.exec(`create role anon; create role authenticated; create role service_role;
      create table profiles(id uuid primary key, coupang_sub_id text);
      create table admin_users(user_id uuid primary key);
      create type reward_status as enum ('PENDING','CONFIRMED','CANCELLED');
      create table rewards(id uuid primary key default gen_random_uuid(),user_id uuid not null references profiles(id),
        source_type text not null,merchant text,source_txn_key text not null unique,
        purchase_amount numeric,purchase_currency text,amount_sats bigint not null check(amount_sats>=0),
        status reward_status not null,confirm_eligible_at timestamptz,confirmed_at timestamptz,
        created_at timestamptz not null default now(),updated_at timestamptz not null default now());
      alter table rewards enable row level security;
      insert into admin_users values('${admin}');
      insert into profiles values('${member}','channel1'),('${other}','channel2');`);
    await db.exec('alter table rewards add constraint positive_only check(amount_sats>0)');
    await assert.rejects(db.exec(migration), /positive-only/);
    await db.exec('rollback; alter table rewards drop constraint positive_only');
    await db.exec(migration);
    const now = () => new Date('2026-10-05T07:00:00Z');
    const range = { startDate: '20260918', endDate: '20260921' };
    const events = normalize(purchase, 'PURCHASE', range, now());
    const cancelEvents = normalize([cancellation], 'CANCEL', range, now());
    async function rpc(batch, role = 'service_role', caller = admin) {
      await db.exec(`begin; set local role ${role}`);
      try {
        const result = await db.query('select public.sync_coupang_rewards($1,$2) result', [caller, JSON.stringify(batch)]);
        await db.exec('commit');
        return result.rows[0].result;
      } catch (error) { await db.exec('rollback'); throw error; }
    }
    const snapshot = async () => ({ rewards: (await db.query('select * from rewards order by source_txn_key')).rows,
      history: (await db.query('select * from rewards_history order by event_key')).rows });
    const reward = async () => (await db.query('select *, (cancelled_at at time zone \'Asia/Seoul\')::date::text cancel_day from rewards where source_txn_key=$1', ['COUPANG:' + order])).rows[0];
    let ordersRows = purchase, cancelRows = [], failOrders = false, failCancels = false, rpcCalls = 0;
    let apiCalls = 0, rpcError = null;
    const config = { SUPABASE_URL: 'https://local.supabase.co', SUPABASE_ANON_KEY: 'public-key',
      SUPABASE_SERVICE_ROLE_KEY: 'server-only', COUPANG_ACCESS_KEY: 'access-secret',
      COUPANG_SECRET_KEY: 'hmac-secret', COUPANG_TRACKING_CODE: 'AF-test' };
    const fetcher = async (url, options) => {
      assert.equal(options.redirect, 'error');
      if (url.includes('/auth/v1/user')) return options.headers.Authorization === 'Bearer invalid'
        ? Response.json({}, { status: 401 }) : Response.json({ id: options.headers.Authorization === 'Bearer member' ? member : admin });
      if (url.includes('/admin_users?')) return Response.json(options.headers.Authorization === 'Bearer member' ? [] : [{ user_id: admin }]);
      if (url.includes('/reports/orders')) {
        apiCalls++;
        assert.match(options.headers.Authorization, /^CEA algorithm=HmacSHA256,/);
        return failOrders ? Response.json({}, { status: 503 }) : Response.json({ rCode: '0', data: ordersRows });
      }
      if (url.includes('/reports/cancels')) {
        apiCalls++;
        return failCancels ? Response.json({}, { status: 503 }) : Response.json({ rCode: '0', data: cancelRows });
      }
      assert.equal(url, config.SUPABASE_URL + '/rest/v1/rpc/sync_coupang_rewards');
      assert.equal(options.method, 'POST');
      assert.equal(options.headers.Authorization, 'Bearer server-only');
      rpcCalls++;
      const body = JSON.parse(options.body);
      try { return Response.json(await rpc(body.p_events, 'service_role', body.p_admin_id)); }
      catch (error) { rpcError = error; return Response.json({ details: 'private-database-error' }, { status: 400 }); }
    };
    const handler = createHandler({ env: key => config[key], fetcher, now });
    const run = (body = range, token = 'admin') => handler(new Request('https://local/sync', {
      method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : {}, body: JSON.stringify(body),
    }));
    for (const [token, status] of [['', 401], ['invalid', 401], ['member', 403]]) assert.equal((await run(range, token)).status, status);
    assert.equal(apiCalls, 0);
    assert.equal(rpcCalls, 0);
    for (const body of [{ ...range, subId: 'channel2' }, { ...range, startDate: 'bad' },
      { ...range, startDate: '20260922' }, { ...range, user_id: member }]) assert.equal((await run(body)).status, 400);

    // Real handler -> mocked provider -> real PostgreSQL RPC -> current projection.
    let response = await run();
    assert.equal(response.status, 200, rpcError?.message);
    assert.equal((await response.json()).result.inserted_events, 2);
    assert.equal(Number((await reward()).purchase_amount), 24900);
    assert.equal(Number((await reward()).amount_sats), 672);
    cancelRows = [cancellation];
    response = await run();
    assert.equal(response.status, 200, rpcError?.message);
    let current = await reward();
    assert.equal(Number(current.purchase_amount), 11900);
    assert.equal(Number(current.amount_sats), 321);
    assert.equal(current.status, 'PENDING');
    assert.equal(current.cancellation_status, 'PARTIAL');
    assert.equal(current.cancel_day, '2026-09-21');
    assert.equal(current.confirm_eligible_at.toISOString(), '2026-11-16T15:00:00.000Z');
    assert.deepEqual((await db.query('select amount_sats from rewards_history order by event_type,event_key')).rows.map(r => Number(r.amount_sats)), [-351, 351, 321]);
    const beforeRepeat = await snapshot();
    const repeated = await (await run()).json();
    assert.equal(repeated.result.inserted_events, 0);
    assert.equal(repeated.result.updated_rewards, 0);
    assert.deepEqual(await snapshot(), beforeRepeat);
    assert.equal((await (await run({ ...range, orderId: '9999' })).json()).result.created_rewards, 0);

    const beforeErrors = await snapshot(), beforeCalls = rpcCalls;
    failOrders = true; assert.equal((await run()).status, 502); failOrders = false;
    failCancels = true; assert.equal((await run()).status, 502); failCancels = false;
    ordersRows = Array(1000).fill(purchase[0]); assert.equal((await run()).status, 422);
    ordersRows = [{ ...purchase[0], orderId: Number.MAX_SAFE_INTEGER + 2 }]; assert.equal((await run()).status, 502);
    ordersRows = purchase;
    assert.equal(rpcCalls, beforeCalls);
    assert.deepEqual(await snapshot(), beforeErrors);

    // History itself must cancel to zero, independently of the full-cancellation clamp.
    await rpc(normalize([{ ...purchase[1], date: '20260922', gmv: -11900, commission: -357 }], 'CANCEL', { ...range, endDate: '20260922' }, now()));
    current = await reward();
    assert.equal(Number(current.amount_sats), 0); assert.equal(Number(current.purchase_amount), 0);
    assert.equal(current.status, 'CANCELLED'); assert.equal(current.cancellation_status, 'FULL');
    assert.equal(current.cancel_day, '2026-09-22');
    assert.equal(Number((await db.query('select sum(amount_sats) total from rewards_history')).rows[0].total), 0);
    const full = await snapshot(); await rpc([...events, ...cancelEvents]); assert.deepEqual(await snapshot(), full);

    // CONFIRMED is immutable even if a new cancellation arrives.
    await db.exec("update rewards set status='CONFIRMED',confirmed_at=now() where source_txn_key='COUPANG:" + order + "'");
    const confirmed = await snapshot();
    assert.equal((await rpc([...events, ...cancelEvents])).skipped[0].reason, 'confirmed_unchanged');
    assert.deepEqual(await snapshot(), confirmed);
    await db.exec('delete from rewards');
    assert.equal((await snapshot()).history.length, 0); // FK cascade is explicitly scoped to history.

    // Adopt a pre-existing test reward only when the complete purchase baseline matches.
    await db.query(`insert into rewards(user_id,source_type,merchant,source_txn_key,purchase_amount,purchase_currency,amount_sats,status)
      values($1,'SHOPPING','COUPANG',$2,24900,'KRW',672,'PENDING')`, [member, 'COUPANG:' + order]);
    let snap = await snapshot();
    await assert.rejects(rpc([events[0], ...cancelEvents]), /complete matching purchase baseline/);
    assert.deepEqual(await snapshot(), snap);
    await rpc([...events, ...cancelEvents]);
    assert.equal(Number((await reward()).amount_sats), 321);
    await db.exec('delete from rewards');

    assert.equal((await rpc(cancelEvents)).skipped[0].reason, 'purchase_missing');
    assert.equal((await rpc(events.map(e => ({ ...e, sub_id: 'not-assigned' })))).skipped[0].reason, 'unmapped_subid');
    assert.equal((await rpc(events.map(e => ({ ...e, sub_id: null })))).skipped[0].reason, 'unmapped_subid');
    assert.equal((await snapshot()).rewards.length, 0);
    await db.exec(`update profiles set coupang_sub_id='channel1' where id='${other}'`);
    await assert.rejects(rpc(events), /Ambiguous channel/);
    await db.exec(`update profiles set coupang_sub_id='channel2' where id='${other}'`);
    await rpc(events);
    snap = await snapshot();
    await assert.rejects(rpc(cancelEvents.map(e => ({ ...e, sub_id: 'channel2' }))), /ownership/);
    assert.deepEqual(await snapshot(), snap);

    // No client can feed arbitrary events directly; service role still needs a current admin.
    await assert.rejects(rpc(events, 'authenticated'), { code: '42501' });
    await assert.rejects(rpc(events, 'anon'), { code: '42501' });
    await assert.rejects(rpc(events, 'service_role', member), { code: '42501' });
    await db.exec('set role authenticated');
    await assert.rejects(db.query('select * from rewards_history'), { code: '42501' });
    await db.exec('reset role');

    // A late SQL failure rolls back earlier orders in the same batch.
    const atomicBefore = await snapshot();
    const good = events.map(e => ({ ...e, order_id: '100' }));
    const bad = events.map(e => ({ ...e, sub_id: 'channel2' }));
    await assert.rejects(rpc([...good, ...bad]), /ownership/);
    assert.deepEqual(await snapshot(), atomicBefore);
    const burst = await Promise.all(Array.from({ length: 5 }, () => db.query('select sync_coupang_rewards($1,$2) r', [admin, JSON.stringify(events)])));
    assert.ok(burst.every(r => r.rows[0].r.inserted_events === 0));
    // Exercise the real RPC calculation for both signs and zero; do not duplicate the formula in JS.
    for (const [commission, expected] of [[357, 321], [390, 351], [0, 0]]) {
      const pairOrder = String(90000 + commission);
      const purchaseRow = { ...purchase[0], orderId: pairOrder, gmv: 100, commission };
      const cancelRow = { ...purchaseRow, date: '20260921', gmv: -100, commission: -commission };
      await rpc([...normalize([purchaseRow], 'PURCHASE', range, now()),
        ...normalize([cancelRow], 'CANCEL', range, now())]);
      const pair = (await db.query(`select h.event_type,h.amount_sats from rewards_history h
        join rewards r on r.id=h.reward_id where r.source_txn_key=$1 order by h.event_type`, ['COUPANG:' + pairOrder])).rows;
      assert.deepEqual(pair.map(row => [row.event_type, Number(row.amount_sats)]),
        [['CANCEL', expected === 0 ? 0 : -expected], ['PURCHASE', expected]]);
      assert.equal(pair.reduce((sum, row) => sum + Number(row.amount_sats), 0), 0);
    }
    // Daily wrapper exercises the SAME RPC and verifies seven-day replay idempotency.
    const { createHandler: dailyHandler } = await import('../supabase/functions/coupang-reward-daily/handler.mjs');
    config.COUPANG_DAILY_SYNC_SECRET = 'a'.repeat(64);
    config.COUPANG_SYNC_ADMIN_ID = admin;
    const daily = dailyHandler({ env: key => config[key], fetcher,
      now: () => new Date('2026-09-21T09:00:00Z'), logger: () => {} });
    const timestamp = String(Date.parse('2026-09-21T09:00:00Z') / 1000);
    const signature = require('node:crypto').createHmac('sha256', Buffer.from(config.COUPANG_DAILY_SYNC_SECRET, 'hex'))
      .update(`btcback-daily-v1\nPOST\n/functions/v1/coupang-reward-daily\n${timestamp}\n{}`).digest('hex');
    const dailyRequest = () => new Request('https://local/daily', { method: 'POST',
      headers: { 'x-btcback-cron-timestamp': timestamp, 'x-btcback-cron-signature': signature }, body: '{}' });
    const firstDaily = await daily(await dailyRequest());
    assert.equal(firstDaily.status, 200, rpcError?.message);
    const dailyData = await firstDaily.json();
    assert.equal(dailyData.startDate, '20260915');
    assert.equal(dailyData.endDate, '20260921');
    assert.equal(Number((await reward()).amount_sats), 321);
    const dailySnapshot = await snapshot();
    const secondDaily = await (await daily(dailyRequest())).json();
    assert.equal(secondDaily.result.inserted_events, 0);
    assert.equal(secondDaily.result.updated_rewards, 0);
    assert.deepEqual(await snapshot(), dailySnapshot);
    console.log('PASS Reward Sync: mocked API -> PostgreSQL E2E 672 -> 321, duplicate/no-op, full cancel, confirmed protection, baseline adoption, mappings, ACL, atomic rollback, safe failures');
  } finally { await db.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
