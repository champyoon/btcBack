import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from '../supabase/functions/coupang-deeplink/handler.mjs';
import { sign } from '../supabase/functions/coupang-deeplink/sign.mjs';
import { sign as localSign } from '../scripts/test-coupang-deeplink.mjs';
const env = name => ({ COUPANG_ACCESS_KEY: 'fixture-access', COUPANG_SECRET_KEY: 'fixture-secret', COUPANG_TRACKING_CODE: 'fixture-code' })[name];
const req = url => new Request('https://test.invalid', { method: 'POST', body: JSON.stringify({ coupangUrl: url }) });
const good = { shortenUrl: 'https://link.coupang.com/a/test', landingUrl: 'https://www.coupang.com/vp/products/123?subid=btcback_test_001' };
test('signer matches existing verified implementation', async () => {
  const date = new Date('2026-09-08T00:00:00Z');
  assert.equal(await sign('a', 'b', date), await localSign('a', 'b', date));
});
test('fixed subId, exact request schema and minimal response', async () => {
  const handler = createHandler({ env, fetcher: async (url, options) => {
    assert.equal(url, 'https://api-gateway.coupang.com/v2/providers/affiliate_open_api/apis/openapi/v1/deeplink');
    assert.equal(options.method, 'POST');
    assert.deepEqual(JSON.parse(options.body), { coupangUrls: ['https://coupang.com/vp/products/123'], subId: 'btcback_test_001' });
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
