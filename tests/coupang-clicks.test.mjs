import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { authorization, createHandler } from '../supabase/functions/coupang-clicks/handler.mjs';

const now = () => new Date('2026-09-10T12:34:56Z');
const config = { SUPABASE_URL: 'https://example.test', SUPABASE_ANON_KEY: 'public-test',
  COUPANG_ACCESS_KEY: 'test-access', COUPANG_SECRET_KEY: 'test-secret', COUPANG_TRACKING_CODE: 'test-tracking' };
// Synthetic values; field names/types match the observed live response, not guessed IDs.
const row = { date: '20260910', trackingCode: 'test-tracking', subId: '260910165746', addtag: '', ctag: '', click: 1 };
const req = (query = '') => new Request('https://function.test/?' + query, { headers: { Authorization: 'Bearer test-session' } });
function fixture({ admin = true, authStatus = 200, memberStatus = 200, upstream = { rCode: '0', data: [row] }, status = 200, missing, nonJson = false, failure } = {}) {
  const calls = [];
  const handler = createHandler({ now, env: n => n === missing ? undefined : config[n], fetcher: async (url, options) => {
    calls.push({ url, options });
    if (url.includes('/auth/v1/')) return Response.json({ id: 'admin-test' }, { status: authStatus });
    if (url.includes('/rest/v1/')) return Response.json(admin ? [{ user_id: 'admin-test' }] : [], { status: memberStatus });
    if (failure) throw failure;
    return nonJson ? new Response('private upstream error') : Response.json(upstream, { status });
  } });
  return { handler, calls };
}

test('clicks signing matches independent HMAC for GET path and exact query', async () => {
  const query = 'startDate=20260909&endDate=20260910&trackingCode=test-tracking';
  const signature = createHmac('sha256', 'test-secret').update('260910T123456ZGET/v2/providers/affiliate_open_api/apis/openapi/v1/reports/clicks' + query).digest('hex');
  assert.equal(await authorization('test-access', 'test-secret', query, now()),
    `CEA algorithm=HmacSHA256, access-key=test-access, signed-date=260910T123456Z, signature=${signature}`);
});

test('clicks denies anonymous, invalid sessions and non-admins before Coupang', async () => {
  const anon = fixture();
  assert.equal((await anon.handler(new Request('https://function.test'))).status, 401);
  assert.equal(anon.calls.length, 0);
  for (const [options, status, calls] of [[{ authStatus: 401 }, 401, 1], [{ admin: false }, 403, 2], [{ memberStatus: 403 }, 503, 2]]) {
    const f = fixture(options);
    assert.equal((await f.handler(req('debug=true'))).status, status);
    assert.equal(f.calls.length, calls);
  }
});

test('clicks validates dates, duplicate/unknown parameters and method', async () => {
  for (const query of ['startDate=20260230', 'startDate=20260911', 'startDate=20260801', 'endDate=20260911',
    'startDate=20260910&endDate=20260909', 'startDate=', 'startDate=%00', 'debug=TRUE', 'debug=true&debug=false', 'endDate=20260909&endDate=20260910', 'trackingCode=override']) {
    const f = fixture();
    assert.equal((await f.handler(req(query))).status, 400, query);
    assert.equal(f.calls.length, 2);
  }
  assert.equal((await fixture().handler(new Request('https://function.test', { method: 'POST' }))).status, 405);
  const result = await (await fixture().handler(req())).json();
  assert.equal(result.startDate, '20260904');
  assert.equal(result.endDate, '20260910');
});

test('clicks returns observed fields only and preserves exact signed request', async () => {
  const f = fixture();
  const response = await f.handler(req('startDate=20260909&endDate=20260910'));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(await response.json(), { startDate: '20260909', endDate: '20260910', count: 1, clicks: [row] });
  const call = f.calls.at(-1), url = new URL(call.url);
  assert.equal(url.origin, 'https://api-gateway.coupang.com');
  assert.equal(url.pathname, '/v2/providers/affiliate_open_api/apis/openapi/v1/reports/clicks');
  assert.equal(url.search, '?startDate=20260909&endDate=20260910&trackingCode=test-tracking');
  assert.equal(call.options.redirect, 'error');
  assert.equal(call.options.headers.Authorization, await authorization('test-access', 'test-secret', url.search.slice(1), now()));
  assert.equal(f.calls[1].options.headers.Authorization, 'Bearer test-session');
  assert.equal(new URL(f.calls[1].url).searchParams.get('user_id'), 'eq.admin-test');
});

test('clicks debug is opt-in, preserves real keys and does not synthesize absent fields', async () => {
  const f = fixture({ upstream: { rCode: 0, data: [{ date: null, subId: 'example', unexpected: 'not returned' }] } });
  const normal = await (await f.handler(req())).json();
  assert.deepEqual(normal.clicks, [{ date: null, subId: 'example' }]);
  assert.deepEqual(await (await f.handler(req('debug=false'))).json(), normal);
  const debug = await (await f.handler(req('debug=true'))).json();
  assert.deepEqual(debug.debug, [{ index: 0, keys: ['date', 'subId', 'unexpected'], identifiers: { subId: 'example' } }]);
  delete debug.debug;
  assert.deepEqual(debug, normal);
  assert(f.calls.every(call => !call.url.includes('debug=')));
  assert.deepEqual((await (await fixture({ upstream: { rCode: '0', data: [] } }).handler(req('debug=true'))).json()).debug, []);
});

test('clicks redacts credentials in normal rows, debug values and even key names', async () => {
  const auth = await authorization('test-access', 'test-secret', 'query', now());
  const data = [{ ...row, date: 'test-access', trackingCode: 'public-test', subId: 'test-session',
    addtag: auth, ctag: { Authorization: 'private' }, click: 'test-secret', 'test-secret': 'private', extra: 'private' }];
  for (const query of ['', 'debug=true']) {
    const text = await (await fixture({ upstream: { rCode: '0', data } }).handler(req(query))).text();
    for (const secret of ['test-access', 'test-secret', 'test-session', 'public-test', 'private', auth]) assert(!text.includes(secret));
    assert(text.includes('[redacted]'));
  }
});

test('clicks rejects malformed responses and missing secrets without raw errors', async () => {
  for (const missing of ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'COUPANG_ACCESS_KEY', 'COUPANG_SECRET_KEY', 'COUPANG_TRACKING_CODE']) {
    assert.equal((await fixture({ missing }).handler(req())).status, 503);
  }
  for (const options of [{ status: 403 }, { nonJson: true }, { upstream: { rCode: '400', rMessage: 'private' } },
    { upstream: { rCode: '0', data: {} } }, { upstream: { rCode: '0', data: [null] } }, { upstream: { rCode: '0', data: [[]] } }]) {
    const response = await fixture(options).handler(req());
    assert.equal(response.status, 502);
    assert(!(await response.text()).includes('private'));
  }
});

test('clicks timeouts and thrown errors do not expose exception text', async () => {
  for (const [failure, status] of [[new DOMException('test-secret', 'TimeoutError'), 504], [new Error('test-secret'), 502]]) {
    const response = await fixture({ failure }).handler(req());
    assert.equal(response.status, status);
    assert(!(await response.text()).includes('test-secret'));
  }
});
