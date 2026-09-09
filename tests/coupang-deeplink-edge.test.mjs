import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHandler, timestampSubId } from '../supabase/functions/coupang-deeplink/handler.mjs';
import { sign } from '../supabase/functions/coupang-deeplink/sign.mjs';
import { sign as localSign } from '../scripts/test-coupang-deeplink.mjs';
const env = name => ({ COUPANG_ACCESS_KEY: 'fixture-access', COUPANG_SECRET_KEY: 'fixture-secret', COUPANG_TRACKING_CODE: 'fixture-code' })[name];
test('timestamp subId uses KST with zero padding and year rollover', () => {
  assert.equal(timestampSubId(new Date('2026-09-09T00:24:35Z')), '260909092435');
  assert.equal(timestampSubId(new Date('2026-09-09T00:24:36Z')), '260909092436');
  assert.equal(timestampSubId(new Date('2026-12-31T15:01:00Z')), '270101000100');
});
const req = url => new Request('https://test.invalid', { method: 'POST', body: JSON.stringify({ coupangUrl: url }) });
const good = { shortenUrl: 'https://link.coupang.com/a/test', landingUrl: 'https://www.coupang.com/vp/products/123?subid=btcback_test_001' };
const affiliateLanding = 'https://link.coupang.com/re/AFFSDP?lptag=AF7466415&subid=btcback_test_001&pageKey=123&itemId=456&vendorItemId=789&traceid=';
test('observed Coupang home landing path is accepted', async () => {
  const landingUrl = 'https://link.coupang.com/re/AFFHOME?subid=btcback_test_001';
  const handler = createHandler({ env, fetcher: async () => Response.json({ rCode: '0', data: [{ ...good, landingUrl }] }) });
  const response = await handler(req('https://www.coupang.com/'));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { success: true, ...good, landingUrl });
});
test('official affiliate landing response preserves fixed subid and both URLs', async () => {
  const handler = createHandler({ env, fetcher: async () => Response.json({ rCode: '0', data: [{ ...good, landingUrl: affiliateLanding }] }) });
  const response = await handler(req('https://www.coupang.com/vp/products/123'));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { success: true, ...good, landingUrl: affiliateLanding });
});
test('affiliate landing validation remains HTTPS, exact host/path and credential safe', async () => {
  for (const landingUrl of [
    affiliateLanding.replace('https:', 'http:'),
    affiliateLanding.replace('link.coupang.com', 'link.coupang.com.evil.test'),
    affiliateLanding.replace('link.coupang.com', 'evil.test'),
    affiliateLanding.replace('link.coupang.com', 'user:pass@link.coupang.com'),
    affiliateLanding.replace('link.coupang.com', 'link.coupang.com:8443'),
    affiliateLanding.replace('/re/AFFSDP', '/other'),
    affiliateLanding.replace('/re/AFFSDP', '/re/AFFSDP-evil'),
    affiliateLanding + '&secret=fixture-secret',
  ]) {
    const handler = createHandler({ env, logger: { error() {} }, fetcher: async () => Response.json({ rCode: '0', data: [{ ...good, landingUrl }] }) });
    const response = await handler(req('https://www.coupang.com'));
    assert.equal(response.status, 502);
    assert.ok(!(await response.text()).includes('fixture-secret'));
  }
});
test('signer matches existing verified implementation', async () => {
  const date = new Date('2026-09-08T00:00:00Z');
  assert.equal(await sign('a', 'b', date), await localSign('a', 'b', date));
});
test('KST timestamp subId, exact request schema and minimal response', async () => {
  const handler = createHandler({ env, now: () => new Date('2026-09-09T00:24:00Z'), fetcher: async (url, options) => {
    assert.equal(url, 'https://api-gateway.coupang.com/v2/providers/affiliate_open_api/apis/openapi/v1/deeplink');
    assert.equal(options.method, 'POST');
    assert.deepEqual(JSON.parse(options.body), { coupangUrls: ['https://coupang.com/vp/products/123'], subId: '260909092400' });
    return Response.json({ rCode: '0', data: [{ ...good, secret: 'fixture-secret' }] });
  } });
  assert.deepEqual(await (await handler(req('https://coupang.com/vp/products/123'))).json(), { success: true, ...good });
  assert.equal((await handler(new Request('https://test.invalid', { method: 'OPTIONS' }))).status, 204);
});
test('reject external hosts, credentials, oversized body and wrong method before fetching', async () => {
  const handler = createHandler({ env, fetcher: () => { throw Error('must not fetch'); } });
  for (const url of ['https://evil.test', 'https://www.coupang.com.evil.test', 'http://coupang.com', 'https://user:pass@coupang.com', 'javascript:alert(1)']) {
    assert.equal((await handler(req(url))).status, 400);
  }
  assert.equal((await handler(new Request('https://test.invalid'))).status, 405);
  assert.equal((await handler(req('x'.repeat(9000)))).status, 413);
});
test('upstream failures and unsafe redirects never expose original bodies', async () => {
  for (const payload of [{ rCode: '400', rMessage: 'fixture-secret' },
    { rCode: '0', data: [{ ...good, shortenUrl: 'https://evil.test' }] },
    { rCode: '0', data: [{ ...good, landingUrl: good.landingUrl + '&secret=fixture-secret' }] }]) {
    const handler = createHandler({ env, fetcher: async () => Response.json(payload) });
    const response = await handler(req('https://www.coupang.com'));
    assert.equal(response.status, 502);
    assert.ok(!(await response.text()).includes('fixture-secret'));
  }
});

test('diagnoses local-only URL rejection after successful Coupang response', async () => {
  const logs = [];
  const handler = createHandler({ env, logger: { error: (...args) => logs.push(args) }, fetcher: async () =>
    Response.json({ rCode: '0', data: [{ ...good, landingUrl: 'https://other.example/path' }] }) });
  const response = await handler(req('https://www.coupang.com'));
  assert.equal(response.status, 502);
  assert.equal((await response.json()).stage, 'landing-url-validation');
  assert.equal(logs[0][1].httpStatus, 200);
  assert.equal(logs[0][1].rCode, '0');
});

test('fetch exceptions and environment exceptions are caught without credentials', async () => {
  const logs = [];
  const logger = { error: (...args) => logs.push(args) };
  const handler = createHandler({ env, logger, fetcher: async () => { throw new TypeError('Authorization fixture-secret'); } });
  const result = await handler(req('https://www.coupang.com'));
  assert.equal(result.status, 502);
  assert.equal((await result.json()).stage, 'coupang-fetch');
  const broken = createHandler({ logger, env: () => { throw Error('fixture-secret'); } });
  assert.equal((await broken(req('https://www.coupang.com'))).status, 500);
  assert.ok(!JSON.stringify(logs).includes('fixture-secret'));
});

test('non-2xx business messages and malformed JSON are diagnosed safely', async () => {
  const logs = [];
  const logger = { error: (...args) => logs.push(args) };
  const handler = createHandler({ env, logger, fetcher: async () => Response.json({ rCode: '400', rMessage: 'url convert failed' }, { status: 403 }) });
  assert.equal((await handler(req('https://www.coupang.com'))).status, 502);
  assert.equal(logs[0][1].httpStatus, 403);
  assert.equal(logs[0][1].rMessage, 'url convert failed');
  const malformed = createHandler({ env, logger, fetcher: async () => new Response('fixture-secret') });
  assert.equal((await (await malformed(req('https://www.coupang.com'))).json()).stage, 'response-parse');
  assert.ok(!JSON.stringify(logs).includes('fixture-secret'));
});
