import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { createHandler, dailyRange } from '../supabase/functions/coupang-reward-daily/handler.mjs';
import { createHandler as manualHandler } from '../supabase/functions/coupang-reward-sync/handler.mjs';
import { createHandler as ordersHandler } from '../supabase/functions/coupang-orders/handler.mjs';
import { createHandler as cancellationsHandler } from '../supabase/functions/coupang-cancellations/handler.mjs';

const id = '11111111-1111-4111-8111-111111111111';
const secret = 'a'.repeat(64); // Synthetic mock credential only.
const defaults = {
  COUPANG_DAILY_SYNC_SECRET: secret, COUPANG_SYNC_ADMIN_ID: id,
  SUPABASE_URL: 'https://mock.supabase.co', SUPABASE_ANON_KEY: 'mock-public',
  SUPABASE_SERVICE_ROLE_KEY: 'mock-server-secret',
  COUPANG_ACCESS_KEY: 'mock-access', COUPANG_SECRET_KEY: 'mock-hmac', COUPANG_TRACKING_CODE: 'AFmock',
};
function fixture({ config = {}, member = true, fail = '', now = () => new Date('2026-10-05T09:00:00Z') } = {}) {
  const values = { ...defaults, ...config }, calls = [], logs = [];
  const quoteTime = new Date().toISOString();
  const env = key => values[key];
  const fetcher = async (url, options) => {
    calls.push({ url, options });
    assert.ok(!JSON.stringify({ url, options }).includes(secret));
    assert.equal(options.redirect, 'error');
    if (url === 'https://api.upbit.com/v1/ticker?markets=KRW-BTC') {
      return Response.json([{ market: 'KRW-BTC', trade_price: 150000000, timestamp: Date.parse(quoteTime) }]);
    }
    if (url.includes('/auth/v1/user')) return Response.json({}, { status: 401 });
    if (url.includes('/admin_users?')) {
      assert.equal(options.headers.Authorization, 'Bearer mock-server-secret');
      assert.match(url, /user_id=eq\.11111111-1111-4111-8111-111111111111/);
      return Response.json(member ? [{ user_id: id }] : []);
    }
    if (url.includes('/reports/')) {
      const parsed = new URL(url);
      assert.equal(parsed.searchParams.get('startDate'), '20260929');
      assert.equal(parsed.searchParams.get('endDate'), '20261005');
      if (fail && url.includes(fail)) return Response.json({ error: 'mock-secret-error' }, { status: 500 });
      return Response.json({ rCode: '0', data: [] });
    }
    assert.equal(url, values.SUPABASE_URL + '/rest/v1/rpc/sync_coupang_rewards');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers.Authorization, 'Bearer mock-server-secret');
    assert.deepEqual(JSON.parse(options.body), { p_admin_id: id, p_events: [],
      p_btc_krw_rate: 150000000, p_btc_rate_at: quoteTime, p_btc_rate_source: 'upbit' });
    if (fail === 'rpc') return Response.json({ detail: 'mock-server-secret' }, { status: 400 });
    return Response.json({ created_rewards: 0, inserted_events: 0, duplicate_events: 0, updated_rewards: 0, skipped: [] });
  };
  const handler = createHandler({ env, fetcher, now, logger: (...args) => logs.push(args) });
  const run = ({ token = secret, body = '{}', query = '', method = 'POST', age = 0, legacy = false } = {}) => {
    const timestamp = String(Math.floor(now().getTime() / 1000) - age);
    const signature = createHmac('sha256', Buffer.from(token, 'hex'))
      .update(`btcback-daily-v1\nPOST\n/functions/v1/coupang-reward-daily\n${timestamp}\n{}`).digest('hex');
    return handler(new Request('https://local/daily' + query, { method,
      headers: legacy ? { 'x-btcback-cron-secret': token } : {
        'x-btcback-cron-timestamp': timestamp, 'x-btcback-cron-signature': signature },
      ...(method === 'POST' ? { body } : {}) }));
  };
  return { run, calls, logs, env, fetcher };
}

test('daily range: KST normal, month/year rollover and UTC boundary', () => {
  for (const [instant, startDate, endDate] of [
    ['2026-10-05T09:00:00Z', '20260929', '20261005'],
    ['2026-11-03T09:00:00Z', '20261028', '20261103'],
    ['2027-01-03T09:00:00Z', '20261228', '20270103'],
    ['2026-10-04T15:00:00Z', '20260929', '20261005'],
    ['2026-10-04T14:59:59Z', '20260928', '20261004'],
  ]) assert.deepEqual(dailyRange(new Date(instant)), { startDate, endDate });
});

test('daily requires scoped secret and valid server config before any fetch', async () => {
  const f = fixture();
  for (const token of ['', 'b'.repeat(64), 'mock-public', 'mock-server-secret', 'Bearer admin']) {
    assert.equal((await f.run({ token })).status, 401);
  }
  assert.equal((await f.run({ method: 'GET' })).status, 405);
  assert.equal((await f.run({ legacy: true })).status, 401);
  assert.equal((await f.run({ age: 301 })).status, 401);
  assert.equal((await f.run({ age: -31 })).status, 401);
  for (const config of [{ COUPANG_DAILY_SYNC_SECRET: '' }, { COUPANG_SYNC_ADMIN_ID: '' }, { SUPABASE_SERVICE_ROLE_KEY: '' }]) {
    const missing = fixture({ config });
    assert.equal((await missing.run()).status, 503);
    assert.equal(missing.calls.length, 0);
  }
  assert.equal(f.calls.length, 0);
});

test('daily cannot select custom dates, admin ID, orders or events', async () => {
  const f = fixture();
  for (const body of ['null', '[]', '"text"', '{', '{"startDate":"20260101"}',
    '{"internalAdminId":"fake"}', '{"orderId":"123"}', '{"p_events":[]}']) {
    assert.equal((await f.run({ body })).status, 400);
  }
  assert.equal((await f.run({ query: '?endDate=20260901' })).status, 400);
  assert.equal(f.calls.length, 0);
});

test('daily rejects malformed or tampered signed headers before accessing providers', async () => {
  const f = fixture();
  const handler = createHandler({ env: f.env, fetcher: f.fetcher,
    now: () => new Date('2026-10-05T09:00:00Z'), logger: () => {} });
  const timestamp = String(Date.parse('2026-10-05T09:00:00Z') / 1000);
  const signature = createHmac('sha256', Buffer.from(secret, 'hex'))
    .update(`btcback-daily-v1\nPOST\n/functions/v1/coupang-reward-daily\n${timestamp}\n{}`).digest('hex');
  for (const headers of [
    {},
    { 'x-btcback-cron-timestamp': timestamp, 'x-btcback-cron-signature': 'malformed' },
    { 'x-btcback-cron-timestamp': 'NaN', 'x-btcback-cron-signature': signature },
    { 'x-btcback-cron-timestamp': String(Number(timestamp) - 1), 'x-btcback-cron-signature': signature },
  ]) {
    assert.equal((await handler(new Request('https://local/daily', { method: 'POST', headers, body: '{}' }))).status, 401);
  }
  assert.equal(f.calls.length, 0);
});

test('daily reuses sync, performs live admin checks, and does not use a user session', async () => {
  const f = fixture();
  const response = await f.run();
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.success, true);
  assert.equal(data.startDate, '20260929'); assert.equal(data.endDate, '20261005');
  assert.equal(f.calls.filter(c => c.url.includes('/auth/')).length, 0);
  assert.equal(f.calls.filter(c => c.url.includes('/admin_users?')).length, 3);
  assert.equal(f.calls.filter(c => c.url.includes('/rpc/')).length, 1);
  assert.equal(f.logs.at(-1)[1].success, true);
  const revoked = fixture({ member: false });
  assert.equal((await revoked.run()).status, 403);
  assert.equal(revoked.calls.length, 1);
});

test('daily failure keeps non-2xx and does not apply partial reports or leak secrets', async () => {
  for (const fail of ['orders', 'cancels', 'rpc']) {
    const f = fixture({ fail });
    const response = await f.run();
    assert.ok(response.status >= 400);
    const output = await response.text();
    assert.equal(JSON.parse(output).success, false);
    assert.equal(f.logs.at(-1)[1].success, false);
    if (fail !== 'rpc') assert.ok(!f.calls.some(c => c.url.includes('/rpc/')));
    for (const value of [secret, 'mock-server-secret', 'mock-access', 'mock-hmac', 'mock-secret-error']) {
      assert.ok(!(output + JSON.stringify(f.logs)).includes(value));
    }
  }
});

test('public sync/report handlers cannot select internal auth using headers/body/query', async () => {
  const f = fixture();
  for (const factory of [manualHandler, ordersHandler, cancellationsHandler]) {
    const handler = factory({ env: f.env, fetcher: f.fetcher });
    const method = factory === manualHandler ? 'POST' : 'GET';
    const response = await handler(new Request('https://local/?internalAdminId=' + id, {
      method, headers: { Authorization: 'Bearer mock-server-secret', 'x-btcback-cron-secret': secret, 'x-internal-admin-id': id },
      ...(method === 'POST' ? { body: JSON.stringify({ internalAdminId: id, startDate: '20260929', endDate: '20261005' }) } : {}),
    }));
    assert.equal(response.status, 401);
  }
  assert.ok(f.calls.every(c => c.url.includes('/auth/v1/user')));
  for (const name of ['coupang-orders', 'coupang-cancellations', 'coupang-reward-sync']) {
    const entry = readFileSync(new URL(`../supabase/functions/${name}/index.ts`, import.meta.url), 'utf8');
    assert.ok(!entry.includes('internalAdminId'));
  }
});
