import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHandler } from '../supabase/functions/coupang-deeplink-no-subid/handler.mjs';
const env = name => ({ SUPABASE_URL: 'https://project.test', SUPABASE_ANON_KEY: 'fixture-public-key', COUPANG_ACCESS_KEY: 'fixture-access', COUPANG_SECRET_KEY: 'fixture-secret', COUPANG_TRACKING_CODE: 'fixture-code' })[name];
const uid = '11111111-1111-4111-8111-111111111111';
const withProfile = (upstream, channel = 'channel1', rows) => async (url, options) => {
  if (url.startsWith('https://project.test')) {
    assert.equal(options.headers.Authorization,'Bearer fixture-user-token');
    assert.equal(options.headers.apikey,'fixture-public-key');
    if (url.endsWith('/auth/v1/user')) return Response.json({id:uid});
    const query = new URL(url).searchParams;
    assert.equal(query.get('id'),`eq.${uid}`);
    assert.equal(query.get('select'),'id,coupang_sub_id');
    return Response.json(rows ?? [{id:uid,coupang_sub_id:channel}]);
  }
  return upstream(url,options);
};
const good = { shortenUrl: 'https://link.coupang.com/a/mock', landingUrl: 'https://link.coupang.com/re/AFFHOME?lptag=fixture-code' };
const req = input => new Request('https://function.test?subId=channel9&user_id=forged', { method: 'POST', headers:{Authorization:'Bearer fixture-user-token'}, body: JSON.stringify(input) });
test('C uses authenticated own-profile channels, ignoring client body/query identity', async () => {
  const config = readFileSync(new URL('../supabase/config.toml', import.meta.url), 'utf8');
  assert.match(config, /\[functions\.coupang-deeplink-no-subid\]\s*verify_jwt\s*=\s*false/);
  let calls = 0;
  for (const channel of ['channel1','channel2','channel3','channel10']) {
  const handler = createHandler({ env, fetcher: withProfile(async (url, options) => {
    calls++;
    assert.equal(url, 'https://api-gateway.coupang.com/v2/providers/affiliate_open_api/apis/openapi/v1/deeplink');
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'error');
    const body = JSON.parse(options.body);
    assert.deepEqual(body, { coupangUrls: ['https://www.coupang.com/'], subId: channel });
    return Response.json({ rCode: '0', data: [good] });
  },channel) });
  for (const input of [{ coupangUrl: 'https://www.coupang.com/' }, { coupangUrl: 'https://www.coupang.com/', subId: 'injected' }]) {
    assert.deepEqual(await (await handler(req(input))).json(), { success: true, ...good });
  }
  assert.equal((await handler(new Request('https://function.test', { method: 'OPTIONS' }))).status, 204);
  }
  assert.equal(calls, 8);
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
    const handler = createHandler({ env, logger: { error() {} }, fetcher: withProfile(async () => Response.json({ rCode: '0', data: [data] })) });
    const response = await handler(req({ coupangUrl: 'https://www.coupang.com/' }));
    assert.equal(response.status, 502);
    assert(!(await response.text()).includes('fixture-secret'));
  }
});

test('C rejects absent/invalid sessions and missing/invalid mappings before Coupang', async()=>{
  const never = ()=>{throw Error('Coupang must not be called');};
  const logger={error(){}};
  const handler=createHandler({env,logger,fetcher:never});
  assert.equal((await handler(new Request('https://function.test',{method:'POST',body:JSON.stringify({coupangUrl:'https://www.coupang.com/'})}))).status,401);
  for(const response of [Response.json({error:'invalid'},{status:401}),Response.json({id:uid,is_anonymous:true})]) {
    const h=createHandler({env,logger,fetcher:async()=>response});
    assert.equal((await h(req({coupangUrl:'https://www.coupang.com/'}))).status,401);
  }
  for(const channel of [null,'','channel0','channel11',' channel1','CHANNEL1','other']) {
    const h=createHandler({env,logger,fetcher:withProfile(never,channel)});
    assert.equal((await h(req({coupangUrl:'https://www.coupang.com/'}))).status,403);
  }
  for(const rows of [[],[{id:'another-user',coupang_sub_id:'channel1'}]]) {
    const h=createHandler({env,logger,fetcher:withProfile(never,'channel1',rows)});
    assert.equal((await h(req({coupangUrl:'https://www.coupang.com/'}))).status,403);
  }
  const failed=createHandler({env,logger,fetcher:withProfile(async()=>Response.json({error:'private'},{status:500}))});
  assert.equal((await failed(req({coupangUrl:'https://www.coupang.com/'}))).status,502);
});
