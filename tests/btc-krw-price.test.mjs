import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHandler } from '../supabase/functions/btc-krw-price/handler.mjs';
import { fetchRewardQuote } from '../supabase/functions/_shared/btc-krw-quote.mjs';

const request = () => new Request('https://btcback.test/functions/v1/btc-krw-price');
const logger = { error() {} };
const instant = Date.parse('2026-10-23T13:15:00Z');
test('public price: fixed Upbit GET, no credentials, minimal response and CORS', async () => {
  const handler = createHandler({ logger, now: () => new Date(instant), fetcher: async (url, options) => {
    assert.equal(url, 'https://api.upbit.com/v1/ticker?markets=KRW-BTC');
    assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'error');
    assert.deepEqual(options.headers, { Accept: 'application/json' });
    assert.ok(options.signal instanceof AbortSignal);
    return Response.json([{ market:'KRW-BTC',trade_price:150000000,timestamp:instant,extra:'not forwarded' }]);
  }});
  const response = await handler(request());
  assert.equal(response.status,200); assert.equal(response.headers.get('Access-Control-Allow-Origin'),'*');
  assert.equal(response.headers.get('Cache-Control'),'no-store');
  assert.deepEqual(await response.json(),{success:true,market:'KRW-BTC',price:150000000,price_at:new Date(instant).toISOString()});
  assert.match(readFileSync(new URL('../supabase/config.toml',import.meta.url),'utf8'),/\[functions\.btc-krw-price\]\s*verify_jwt\s*=\s*false/);
});
test('price preflight and invalid requests never reach Upbit', async () => {
  let calls=0;
  const handler=createHandler({logger,fetcher:()=>{calls++;throw Error('Unexpected');}});
  assert.equal((await handler(new Request(request(),{method:'OPTIONS'}))).status,204);
  assert.equal((await handler(new Request(request(),{method:'POST'}))).status,405);
  assert.equal((await handler(new Request(request().url+'?url=https://example.com'))).status,400);
  assert.equal(calls,0);
});

test('public price rejects missing, stale and future exchange timestamps', async () => {
  for (const timestamp of [undefined, null, instant-300001, instant+30001]) {
    const response = await createHandler({ logger, now: () => new Date(instant),
      fetcher: async () => Response.json([{market:'KRW-BTC',trade_price:150000000,timestamp}]) })(request());
    assert.equal(response.status,502);
    assert.deepEqual(await response.json(),{success:false,error:'price_unavailable'});
  }
});
test('price rejects invalid schemas and nonpositive/nonfinite/nonnumeric prices', async () => {
  for(const body of [null,{},[],[{}],[{market:'KRW-ETH',trade_price:150000000}],
    ...[null,0,-1,'150000000',true,Infinity,Number.MAX_VALUE].map(trade_price=>[{market:'KRW-BTC',trade_price}]),
    [{market:'KRW-BTC',trade_price:1},{market:'KRW-BTC',trade_price:2}]]) {
    const response=await createHandler({logger,fetcher:async()=>Response.json(body)})(request());
    assert.equal(response.status,502);assert.deepEqual(await response.json(),{success:false,error:'price_unavailable'});
  }
});
test('HTTP, JSON and network errors are safe; no raw error contents escape', async () => {
  const entries=[];
  for(const fetcher of [async()=>new Response('untrusted secret',{status:429}),async()=>new Response('untrusted secret',{status:500}),async()=>new Response('not json'),async()=>{throw Error('untrusted secret');}]) {
    const response=await createHandler({logger:{error:(...args)=>entries.push(args)},fetcher})(request());
    assert.equal(response.status,502);assert.ok(!(await response.text()).includes('untrusted'));
  }
  assert.ok(!JSON.stringify(entries).includes('untrusted'));
});
test('Upbit timeout is bounded and reported independently', async () => {
  const response=await createHandler({logger,timeoutMs:5,fetcher:async(_url,{signal})=>{
    await new Promise(resolve=>setTimeout(resolve,20));signal.throwIfAborted();throw Error('Expected timeout');
  }})(request());
  assert.equal(response.status,504);assert.deepEqual(await response.json(),{success:false,error:'price_timeout'});
});

test('reward quote uses ticker timestamp, checks freshness and precision without fallback', async () => {
  const instant = Date.parse('2026-10-21T09:00:00Z');
  const now = () => new Date(instant);
  let calls = 0;
  const fetcher = async () => { calls++; return Response.json([{ market: 'KRW-BTC',
    trade_price: 150000000, timestamp: instant - 10000, trade_timestamp: instant - 20000 }]); };
  assert.deepEqual(await fetchRewardQuote({ fetcher, now }),
    { rate: 150000000, rateAt: new Date(instant - 10000).toISOString(), source: 'upbit' });
  assert.equal(calls, 1);
  for (const timestamp of [undefined, null, '123', 0, instant-300001, instant+30001, instant+0.5]) {
    await assert.rejects(fetchRewardQuote({ now, fetcher: async () => Response.json([
      { market: 'KRW-BTC', trade_price: 150000000, timestamp },
    ]) }), /Invalid or stale/);
  }
  await assert.rejects(fetchRewardQuote({ now, fetcher: async () => Response.json([
    { market: 'KRW-BTC', trade_price: 1.001, timestamp: instant },
  ]) }), /Invalid or stale/);
});
