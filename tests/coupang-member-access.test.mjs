import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHandler as memberHandler } from '../supabase/functions/coupang-deeplink-no-subid/handler.mjs';
import { createHandler as legacyHandler } from '../supabase/functions/coupang-deeplink/handler.mjs';

const id = '11111111-1111-4111-8111-111111111111';
const env = name => ({ SUPABASE_URL: 'https://auth.test', SUPABASE_ANON_KEY: 'public-fixture', COUPANG_ACCESS_KEY: 'private-access', COUPANG_SECRET_KEY: 'private-secret', COUPANG_TRACKING_CODE: 'fixture' })[name];
const request = (token = 'fixture-token') => new Request('https://edge.test?member_status=APPROVED&subId=channel9', {
  method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : {},
  body: JSON.stringify({ coupangUrl: 'https://www.coupang.com/', user_id: 'forged', subId: 'channel9', member_status: 'APPROVED' }),
});
for (const [name, createHandler] of [['member', memberHandler], ['legacy', legacyHandler]]) {
  test(`${name}: server-only APPROVED authorization, CORS, failures and channel preservation`, async () => {
    for (const scenario of [
      { channel: 'channel1', status: 'APPROVED', expected: 200 },
      { channel: 'channel2', status: 'APPROVED', expected: 200 },
      ...['PENDING','BLOCKED','UNKNOWN',null,undefined].map(status => ({ status, expected: 403 })),
      { missing: true, expected: 403 },
      { channel: null, expected: 403 }, { channel: '', expected: 403 }, { channel: 'channel11', expected: 403 },
      { token: null, expected: 401 }, { authStatus: 401, token: 'forged-token', expected: 401 },
      { authStatus: 401, token: 'expired-token', expected: 401 },
      { profileStatus: 500, expected: 503 }, { malformed: true, expected: 503 },
      { network: true, expected: 503 }, { authStatus: 503, expected: 503 },
    ]) {
      let providerCalls = 0, authCalls = 0;
      const logs = [];
      const handler = createHandler({ env, now: () => new Date('2026-09-09T00:24:35Z'), logger: { error: entry => logs.push(entry) }, fetcher: async (url, options) => {
        if (url === 'https://auth.test/auth/v1/user') {
          authCalls++;
          assert.equal(options.headers.Authorization, `Bearer ${scenario.token ?? 'fixture-token'}`);
          return Response.json({ id }, { status: scenario.authStatus || 200 });
        }
        if (url.startsWith('https://auth.test/rest/v1/profiles?')) {
          assert.equal(new URL(url).searchParams.get('id'), `eq.${id}`);
          assert.equal(new URL(url).searchParams.get('select'), 'id,member_status,coupang_sub_id');
          if (scenario.network) throw Error('private-secret');
          if (scenario.malformed) return new Response('private-secret');
          return Response.json(scenario.missing ? [] : [{ id,
            member_status: Object.hasOwn(scenario, 'status') ? scenario.status : 'APPROVED',
            coupang_sub_id: Object.hasOwn(scenario, 'channel') ? scenario.channel : 'channel1',
          }], { status: scenario.profileStatus || 200 });
        }
        providerCalls++;
        assert.deepEqual(JSON.parse(options.body), { coupangUrls: ['https://www.coupang.com/'], subId: name === 'member' ? scenario.channel : '260909092435' });
        return Response.json({ rCode: '0', data: [{ shortenUrl: 'https://link.coupang.com/a/test', landingUrl: 'https://link.coupang.com/re/AFFHOME' }] });
      } });
      const preflight = await handler(new Request('https://edge.test', { method: 'OPTIONS' }));
      assert.equal(preflight.status, 204); assert.equal(authCalls, 0);
      const result = await handler(request(Object.hasOwn(scenario, 'token') ? scenario.token : 'fixture-token'));
      assert.equal(result.status, scenario.expected, JSON.stringify(scenario));
      assert.equal(result.headers.get('access-control-allow-origin'), '*');
      assert.equal(providerCalls, scenario.expected === 200 ? 1 : 0);
      assert.doesNotMatch(await result.text() + JSON.stringify(logs), /private-secret|fixture-token|forged-token|expired-token/);
    }
  });
}
