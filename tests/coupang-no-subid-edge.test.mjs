import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHandler } from '../supabase/functions/coupang-deeplink-no-subid/handler.mjs';
const env = name => ({ COUPANG_ACCESS_KEY: 'fixture-access', COUPANG_SECRET_KEY: 'fixture-secret', COUPANG_TRACKING_CODE: 'fixture-code' })[name];
const good = { shortenUrl: 'https://link.coupang.com/a/mock', landingUrl: 'https://link.coupang.com/re/AFFHOME?lptag=fixture-code' };
const req = input => new Request('https://function.test', { method: 'POST', body: JSON.stringify(input) });
test('C sends fixed channel1, ignoring client subId, with public JWT configuration', async () => {
  const config = readFileSync(new URL('../supabase/config.toml', import.meta.url), 'utf8');
  assert.match(config, /\[functions\.coupang-deeplink-no-subid\]\s*verify_jwt\s*=\s*false/);
  let calls = 0;
  const handler = createHandler({ env, fetcher: async (url, options) => {
    calls++;
    assert.equal(url, 'https://api-gateway.coupang.com/v2/providers/affiliate_open_api/apis/openapi/v1/deeplink');
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'error');
    const body = JSON.parse(options.body);
    assert.deepEqual(body, { coupangUrls: ['https://www.coupang.com/'], subId: 'channel1' });
    return Response.json({ rCode: '0', data: [good] });
  } });
  for (const input of [{ coupangUrl: 'https://www.coupang.com/' }, { coupangUrl: 'https://www.coupang.com/', subId: 'injected' }]) {
    assert.deepEqual(await (await handler(req(input))).json(), { success: true, ...good });
  }
  assert.equal(calls, 2);
  assert.equal((await handler(new Request('https://function.test', { method: 'OPTIONS' }))).status, 204);
});
test('C preserves unsafe input rejection and request limits', async () => {
  const handler = createHandler({ env, logger: { error() {} }, fetcher: () => { throw Error('must not fetch'); } });
  for (const coupangUrl of ['http://coupang.com/', 'https://evil.test/', 'https://user:pass@coupang.com/', 'https://coupang.com:8443/']) {
    assert.equal((await handler(req({ coupangUrl }))).status, 400);
  }
  assert.equal((await handler(req({ coupangUrl: 'x'.repeat(9000) }))).status, 413);
  assert.equal((await handler(new Request('https://function.test'))).status, 405);
});
test('C preserves response URL validation, safe errors and secret masking', async () => {
  for (const data of [{ ...good, shortenUrl: 'https://evil.test' }, { ...good, landingUrl: 'https://link.coupang.com/wrong' },
    { ...good, landingUrl: good.landingUrl + '&secret=fixture-secret' }]) {
    const handler = createHandler({ env, logger: { error() {} }, fetcher: async () => Response.json({ rCode: '0', data: [data] }) });
    const response = await handler(req({ coupangUrl: 'https://www.coupang.com/' }));
    assert.equal(response.status, 502);
    assert(!(await response.text()).includes('fixture-secret'));
  }
});
