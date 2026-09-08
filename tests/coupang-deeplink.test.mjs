import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { parseArgs, run, sign } from '../scripts/test-coupang-deeplink.mjs';
const options = { url: 'https://www.coupang.com/vp/products/123?itemId=456' };
const BODY = { coupangUrls: [options.url], subId: 'btcback_test_001' };

const env = { COUPANG_ACCESS_KEY: 'fixture-access', COUPANG_SECRET_KEY: 'fixture-secret', COUPANG_TRACKING_CODE: 'fixture-tracking' };
test('POST HMAC matches independent reference', async () => {
  const signature = createHmac('sha256', env.COUPANG_SECRET_KEY)
    .update('260908T123456ZPOST/v2/providers/affiliate_open_api/apis/openapi/v1/deeplink').digest('hex');
  assert.equal(await sign(env.COUPANG_ACCESS_KEY, env.COUPANG_SECRET_KEY, new Date('2026-09-08T12:34:56Z')),
    `CEA algorithm=HmacSHA256, access-key=fixture-access, signed-date=260908T123456Z, signature=${signature}`);
});
test('only documented fields sent; response is allowlisted and credentials redacted', async () => {
  const result = await run(options, env, async (url, options) => {
    assert.equal(new URL(url).search, '');
    assert.equal(options.method, 'POST');
    assert.deepEqual(JSON.parse(options.body), BODY);
    assert.equal(BODY.subId, 'btcback_test_001');
    assert.deepEqual(Object.keys(BODY), ['coupangUrls', 'subId']);
    return Response.json({ rCode: '0', rMessage: env.COUPANG_SECRET_KEY,
      Authorization: options.headers.Authorization, data: [{ shortenUrl: 'https://example.test', secret: env.COUPANG_ACCESS_KEY }] });
  });
  assert.deepEqual(result, { httpStatus: 200, rCode: '0', rMessage: '[redacted]', originalUrl: null, shortenUrl: 'https://example.test', landingUrl: null });
});
test('HTTP errors preserved and non-JSON contents omitted', async () => {
  const result = await run(options, env, async () => new Response('private upstream body', { status: 403 }));
  assert.equal(result.httpStatus, 403);
  assert.equal(result.rMessage, null);
  await assert.rejects(run(options, {}, async () => { throw Error('must not fetch'); }));
});

test('CLI defaults, explicit modes and invalid inputs', () => {
  assert.equal(parseArgs([options.url]).withSubId, true);
  assert.equal(parseArgs(['--with-subid', options.url]).withSubId, true);
  assert.equal(parseArgs([options.url, '--without-subid']).withSubId, false);
  for (const args of [[], [options.url, '--bad'], [options.url, '--with-subid', '--without-subid'],
    [options.url, options.url], ['https://example.com'], ['https://www.coupang.com.evil.test'], ['http://www.coupang.com'], ['https://user:password@www.coupang.com']]) assert.throws(() => parseArgs(args));
});

test('both modes preserve URL and only vary subId', async () => {
  for (const withSubId of [true, false]) {
    await run({ ...options, withSubId }, env, async (url, request) => {
      assert.deepEqual(JSON.parse(request.body), withSubId ? BODY : { coupangUrls: [options.url] });
      return Response.json({ rCode: '400', rMessage: 'url convert failed' });
    });
  }
});
