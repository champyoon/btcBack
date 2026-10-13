import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createHandler, authorization } from '../supabase/functions/coupang-cancellations/handler.mjs';

const now = () => new Date('2026-09-23T07:00:00Z');
const config = { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_ANON_KEY: 'public-key',
  COUPANG_ACCESS_KEY: 'private-access', COUPANG_SECRET_KEY: 'private-secret', COUPANG_TRACKING_CODE: 'AF-test',
  SUPABASE_SERVICE_ROLE_KEY: 'private-service' };
const sample = { orderDate: '20260918', date: '20260921', orderId: '8914185084332805',
  productId: '13352471', subId: 'channel1', trackingCode: 'AF-test', productName: 'sample',
  quantity: -1, gmv: -13000, commission: -390, commissionRate: 3, addtag: '900', ctag: 'HOME' };
function fixture({ admin = true, valid = true, pages = [[]], upstream } = {}) {
  const calls = [];
  const handler = createHandler({ env: key => config[key], now, fetcher: async (url, options) => {
    calls.push({ url, options });
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    if (url.includes('/auth/v1/user')) return Response.json({ id: 'admin-id' }, { status: valid ? 200 : 401 });
    if (url.includes('/rest/v1/')) {
      assert.match(url, /\/admin_users\?/);
      assert.equal(options.headers.Authorization, 'Bearer user-jwt');
      return Response.json(admin ? [{ user_id: 'admin-id' }] : []);
    }
    const parsed = new URL(url);
    assert.equal(parsed.pathname, '/v2/providers/affiliate_open_api/apis/openapi/v1/reports/cancels');
    assert.deepEqual([...parsed.searchParams.keys()].sort(), ['endDate', 'page', 'startDate']);
    return upstream ? upstream(parsed, options) : Response.json({ rCode: '0', data: pages[Number(parsed.searchParams.get('page'))] });
  } });
  const run = (query = '', token = 'Bearer user-jwt') => handler(new Request(
    'https://local/coupang-cancellations?startDate=20260901&endDate=20260922' + query,
    { headers: token ? { Authorization: token } : {} }));
  return { run, calls };
}

test('cancellations uses exact verified HMAC format', async () => {
  const query = 'startDate=20260921&endDate=20260921&page=0';
  const signature = createHmac('sha256', 'secret').update('260923T070000ZGET/v2/providers/affiliate_open_api/apis/openapi/v1/reports/cancels' + query).digest('hex');
  assert.equal(await authorization('access', 'secret', query, now()),
    `CEA algorithm=HmacSHA256, access-key=access, signed-date=260923T070000Z, signature=${signature}`);
});

test('cancellations denies missing/invalid sessions and non-admins before provider access', async () => {
  const missing = fixture();
  assert.equal((await missing.run('', '')).status, 401);
  assert.equal(missing.calls.length, 0);
  for (const [options, status, count] of [[{ valid: false }, 401, 1], [{ admin: false }, 403, 2]]) {
    const f = fixture(options);
    assert.equal((await f.run()).status, status);
    assert.equal(f.calls.length, count);
  }
});

test('cancellations validates dates and query; zero rows succeed without debug', async () => {
  const f = fixture();
  const result = await (await f.run()).json();
  assert.deepEqual(result.cancellations, []);
  assert.equal(result.success, true);
  assert.equal(result.debug, undefined);
  for (const dates of ['startDate=bad&endDate=20260922', 'startDate=20260922&endDate=20260921',
    'startDate=20260230&endDate=20260301', 'startDate=20260801&endDate=20260922']) {
    const handler = createHandler({ env: k => config[k], now, fetcher: async url =>
      Response.json(url.includes('/auth/') ? { id: 'a' } : [{ user_id: 'a' }]) });
    assert.equal((await handler(new Request('https://local/?' + dates, { headers: { Authorization: 'Bearer user-jwt' } }))).status, 400);
  }
  assert.equal((await f.run('&debug=invalid')).status, 400);
  assert.equal((await f.run('&page=1')).status, 400);
});

test('cancellations follows all pages and preserves duplicates, signs, unknown fields; no writes', async () => {
  const f = fixture({ pages: [Array.from({ length: 1000 }, () => sample), [{ ...sample, extra: { observed: true } }]] });
  const response = await f.run('&debug=true');
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.count, 1001);
  assert.deepEqual(result.cancellations[0], sample);
  assert.deepEqual(result.cancellations[999], sample);
  assert.deepEqual(result.cancellations[1000].extra, { observed: true });
  assert.deepEqual(result.debug.pages, [{ page: 0, count: 1000 }, { page: 1, count: 1 }]);
  assert.ok(result.debug.records[1000].keys.includes('extra'));
  assert.equal(f.calls.length, 4);
});

test('cancellations never returns partial success after page failure or page limit', async () => {
  for (const second of [() => new Response('failure', { status: 500 }),
    () => Response.json({ rCode: '400' }), () => new Response('bad json')]) {
    const f = fixture({ upstream: url => url.searchParams.get('page') === '0'
      ? Response.json({ rCode: '0', data: Array(1000).fill(sample) }) : second() });
    const response = await f.run();
    assert.equal(response.status, 502);
    const result = await response.json();
    assert.equal(result.success, false);
    assert.equal(result.cancellations, undefined);
  }
  const f = fixture({ upstream: () => Response.json({ rCode: '0', data: Array(1000).fill({}) }) });
  assert.equal((await (await f.run()).json()).error, 'pagination_limit_exceeded');
});

test('cancellations redacts secrets recursively and preserves large identifier digits', async () => {
  const f = fixture({ upstream: (_url, options) => new Response(
    '{"rCode":"0","data":[{"orderId":8914185084332805,"nested":' + JSON.stringify({
      unexpected: config.COUPANG_SECRET_KEY, authorization: options.headers.Authorization,
      token: 'other-token', value: 'user-jwt', service: config.SUPABASE_SERVICE_ROLE_KEY,
    }) + '}]}') });
  const result = await (await f.run('&debug=true')).json();
  assert.equal(result.cancellations[0].orderId, '8914185084332805');
  const output = JSON.stringify(result);
  for (const secret of ['private-secret', 'private-access', 'private-service', 'user-jwt', 'other-token', 'CEA algorithm']) assert.ok(!output.includes(secret));
  const large = fixture({ upstream: () => new Response('{"rCode":"0","data":[{"orderId":9999999999999999}]}') });
  const largeResult = await (await large.run()).json();
  if (largeResult.success) assert.equal(largeResult.cancellations[0].orderId, '9999999999999999');
  else assert.equal(largeResult.error, 'coupang_invalid_json_or_unsafe_id');
});
