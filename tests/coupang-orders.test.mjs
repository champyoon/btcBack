import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { authorization, createHandler, dateRange } from '../supabase/functions/coupang-orders/handler.mjs';

const now = () => new Date('2026-09-08T12:34:56Z');
test('HMAC uses UTC, full path and exact query without question mark', async () => {
  const query = 'startDate=20260901&endDate=20260908&trackingCode=test';
  const message = '260908T123456ZGET/v2/providers/affiliate_open_api/apis/openapi/v1/reports/orders' + query;
  const expected = createHmac('sha256', 'test-only').update(message).digest('hex');
  assert.equal(await authorization('test', 'test-only', query, now()),
    `CEA algorithm=HmacSHA256, access-key=test, signed-date=260908T123456Z, signature=${expected}`);
});
test('date defaults and invalid ranges', () => {
  assert.deepEqual(dateRange(new URLSearchParams(), now()), { startDate: '20260902', endDate: '20260908' });
  for (const query of ['startDate=20260230', 'startDate=20260909', 'startDate=20260801', 'endDate=20260909', 'startDate=bad']) {
    assert.throws(() => dateRange(new URLSearchParams(query), now()));
  }
});
const config = { SUPABASE_URL: 'https://example.test', SUPABASE_ANON_KEY: 'public-test',
  COUPANG_ACCESS_KEY: 'test-access', COUPANG_SECRET_KEY: 'test-only', COUPANG_TRACKING_CODE: 'test-tracking' };
const req = (query = '') => new Request('https://function.test/?' + query, { headers: { Authorization: 'Bearer test-session' } });
function fixture({ admin = true, upstream = { rCode: '0', data: [{ orderId: '123', productName: 'test', commission: 1 }] }, status = 200, missing = false } = {}) {
  const calls = [];
  const handler = createHandler({ now, env: n => missing && n === 'COUPANG_SECRET_KEY' ? undefined : config[n], fetcher: async (url, options) => {
    calls.push({ url, options });
    if (url.includes('/auth/v1/')) return Response.json({ id: 'admin-test' });
    if (url.includes('/rest/v1/')) return Response.json(admin ? [{ user_id: 'admin-test' }] : []);
    return Response.json(upstream, { status });
  } });
  return { handler, calls };
}
test('anonymous and non-admin callers never reach Coupang', async () => {
  const { handler, calls } = fixture({ admin: false });
  assert.equal((await handler(new Request('https://function.test'))).status, 401);
  assert.equal(calls.length, 0);
  assert.equal((await handler(req())).status, 403);
  assert.equal(calls.length, 2);
});
test('admin gets projected fields; exact signed query and no secrets in result', async () => {
  const { handler, calls } = fixture();
  const response = await handler(req());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const result = await response.json();
  assert.equal(result.orders[0].orderId, '123');
  assert.equal(Object.keys(result.orders[0]).length, 11);
  assert.equal(result.orders[0].subId, null);
  const last = calls.at(-1);
  assert.equal(last.options.headers.Authorization, await authorization('test-access', 'test-only', new URL(last.url).search.slice(1), now()));
  assert.ok(!JSON.stringify(result).includes('test-only'));
});
test('validation, missing secrets and upstream failures fail closed', async () => {
  assert.equal((await fixture().handler(req('startDate=bad'))).status, 400);
  assert.equal((await fixture({ missing: true }).handler(req())).status, 503);
  for (const options of [{ status: 403 }, { upstream: { rCode: 'error', rMessage: 'sensitive' } }, { upstream: { rCode: '0', data: {} } }]) {
    const response = await fixture(options).handler(req());
    assert.equal(response.status, 502);
    assert.ok(!(await response.text()).includes('sensitive'));
  }
});

test('debug is opt-in and does not change normal response or upstream query', async () => {
  const { handler, calls } = fixture();
  const normal = await (await handler(req())).json();
  for (const value of ['false', 'TRUE', '1']) {
    assert.deepEqual(await (await handler(req('debug=' + value))).json(), normal);
  }
  const debug = await (await handler(req('debug=true'))).json();
  assert.deepEqual(debug.debug[0].keys, ['orderId', 'productName', 'commission']);
  assert.deepEqual(debug.debug[0].identifiers, { orderId: '123' });
  delete debug.debug;
  assert.deepEqual(debug, normal);
  assert.ok(calls.every(call => !call.url.includes('debug=')));
});

test('debug reports presence including null, omits arbitrary values and redacts secrets', async () => {
  const row = { orderId: '123', orderNumber: null, subParam: 'test-only',
    addtag: { Authorization: 'private' }, ctag: 'Bearer private', vendorItemId: '456',
    Authorization: 'private', secretKey: 'private', extraField: 'private' };
  const { handler } = fixture({ upstream: { rCode: '0', data: [row] } });
  const response = await (await handler(req('debug=true'))).json();
  assert.deepEqual(response.debug[0].keys, Object.keys(row));
  assert.deepEqual(response.debug[0].identifiers, {
    orderNumber: null, orderId: '123', subParam: '[redacted]',
    addtag: '[omitted: non-scalar]', ctag: '[redacted]', vendorItemId: '456',
  });
  assert.ok(!JSON.stringify(response).includes('private'));
  assert.equal((await fixture({ admin: false }).handler(req('debug=true'))).status, 403);
  assert.deepEqual((await (await fixture({ upstream: { rCode: '0', data: [] } }).handler(req('debug=true'))).json()).debug, []);
});
