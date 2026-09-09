import { test } from 'node:test';
import assert from 'node:assert/strict';
import { samples, diagnose, summary } from '../scripts/diagnose-coupang-deeplink.mjs';

test('known samples and exact optional URLs; no invented option/category paths', () => {
  assert.equal(samples([]).length, 3);
  const url = 'https://www.coupang.com/vp/products/123?itemId=456&vendorItemId=789';
  assert.equal(samples(['--product-options', url])[2].url, url);
  for (const args of [['--bad', url], ['--category'], ['--product-options', 'https://www.coupang.com/'], ['--category', 'https://evil.test']]) assert.throws(() => samples(args));
});
test('two modes sequentially use existing runner, mask output and summarize', async () => {
  const calls = [], output = [];
  const cases = samples([]);
  const rows = await diagnose(cases, { env: { COUPANG_SECRET_KEY: 'private-fixture' }, pause: async () => {}, output: s => output.push(s), runner: async options => {
    calls.push(options);
    const home = options.url === 'https://www.coupang.com/';
    return { httpStatus: 200, rCode: home ? '400' : '0', rMessage: home ? 'url convert failed' : 'private-fixture', originalUrl: options.url,
      shortenUrl: home ? null : 'https://link.coupang.com/a/test', landingUrl: home ? null : 'https://link.coupang.com/re/AFFSDP' };
  } });
  assert.equal(calls.length, 6);
  assert.deepEqual(calls.slice(0, 2), [{ url: cases[0].url, withSubId: false }, { url: cases[0].url, withSubId: true }]);
  assert.ok(!output.join('').includes('private-fixture'));
  assert.ok(!output.join('').includes('https://link.coupang.com'));
  assert.equal(rows[0].rMessage, 'url convert failed');
  assert.equal(summary(rows)[0]['with subId'], 'FAIL');
  assert.equal(summary(rows)[1]['with subId'], 'PASS');
});
test('transport failure is inconclusive and does not leak exception or stop next mode', async () => {
  let calls = 0;
  const output = [];
  const rows = await diagnose(samples([]).slice(0, 1), { env: {}, pause: async () => {}, output: s => output.push(s), runner: async () => { calls++; throw Error('secret-fixture'); } });
  assert.equal(calls, 2);
  assert.equal(summary(rows)[0]['without subId'], 'INCONCLUSIVE');
  assert.ok(!output.join('').includes('secret-fixture'));
});
