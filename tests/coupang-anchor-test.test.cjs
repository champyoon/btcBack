const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const read = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
const source = read('coupang-anchor-test.js');
assert(!/location\.(?:assign|replace)|window\.open|javascript:|\.click\(/.test(source));
assert(!/landingUrl|subId|tracking_id/.test(source));
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const endpoint = 'https://pqlombgqscbacjkudirl.supabase.co/functions/v1/coupang-deeplink';
    const short = 'https://link.coupang.com/a/mock';
    let output = short, failure = false, calls = 0, release, delayed = false, referer;
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.href === endpoint) {
        calls++;
        assert.equal(route.request().method(), 'POST');
        assert.deepEqual(route.request().postDataJSON(), { coupangUrl: 'https://www.coupang.com/' });
        if (delayed) await new Promise(resolve => { release = resolve; });
        return route.fulfill({ status: failure ? 502 : 200, contentType: 'application/json',
          headers: { 'Access-Control-Allow-Origin': '*' },
          body: JSON.stringify({ success: !failure, shortenUrl: output, landingUrl: 'https://www.coupang.com/not-used' }) });
      }
      if (url.href === short || url.href === 'https://coupa.ng/mock') {
        referer = route.request().headers().referer;
        return route.fulfill({ contentType: 'text/html', body: 'Mock destination' });
      }
      if (url.hostname === 'btcback.test' && ['/shopping.html','/common.css','/coupang-anchor-test.js'].includes(url.pathname)) {
        return route.fulfill({ contentType: url.pathname.endsWith('.css') ? 'text/css' : url.pathname.endsWith('.js') ? 'text/javascript' : 'text/html', body: read(url.pathname.slice(1)) });
      }
      return route.abort();
    });
    await page.goto('https://btcback.test/shopping.html');
    const prepare = page.locator('#coupang-anchor-prepare'), link = page.locator('#coupang-anchor-link');
    assert.equal(await prepare.innerText(), '쿠팡으로 이동하기 (테스트)');
    assert.equal(await link.getAttribute('target'), '_blank');
    assert.equal(await link.getAttribute('referrerpolicy'), 'unsafe-url');
    assert.equal(await link.getAttribute('rel'), 'noopener');
    assert.equal(await link.getAttribute('href'), null);
    assert(await prepare.isVisible());
    for (const width of [320,390,768,1440]) {
      await page.setViewportSize({ width, height: 900 });
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      const box = await prepare.boundingBox();
      assert(box.x >= 0 && box.x + box.width <= width && box.height >= 44);
    }
    failure = true;
    await prepare.click();
    await page.waitForFunction(() => !document.getElementById('coupang-anchor-prepare').disabled);
    assert((await page.locator('#coupang-anchor-status').innerText()).length > 0);
    failure = false;
    for (output of ['http://link.coupang.com/a/mock','https://evil.test/','https://link.coupang.com.evil.test/',
      'https://user:pass@link.coupang.com/a/mock','https://link.coupang.com:8443/a/mock','javascript:alert(1)']) {
      await prepare.click();
      await page.waitForFunction(() => !document.getElementById('coupang-anchor-prepare').disabled);
      assert.equal(await link.getAttribute('href'), null);
      assert(!(await link.isVisible()));
    }
    output = short;
    delayed = true;
    const before = calls;
    await prepare.click();
    await page.waitForFunction(() => document.getElementById('coupang-anchor-prepare').disabled);
    await prepare.dispatchEvent('click');
    while (!release) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(calls, before + 1);
    delayed = false; release();
    await link.waitFor({ state: 'visible' });
    assert.equal(page.url(), 'https://btcback.test/shopping.html');
    assert.equal(context.pages().length, 1);
    assert.equal(await link.getAttribute('href'), short);
    for (const width of [320,390,768,1440]) {
      await page.setViewportSize({ width, height: 900 });
      const box = await link.boundingBox();
      assert(box.x >= 0 && box.x + box.width <= width && box.height >= 44);
    }
    const popupPromise = page.waitForEvent('popup');
    await link.focus();
    await page.keyboard.press('Enter');
    const popup = await popupPromise;
    await popup.waitForLoadState();
    assert.equal(popup.url(), short);
    assert.equal(referer, 'https://btcback.test/shopping.html');
    assert.equal(page.url(), 'https://btcback.test/shopping.html');
    assert.equal(calls, before + 1);
    assert.equal(await popup.evaluate(() => window.opener), null);
    await popup.close();
    await prepare.waitFor({ state: 'visible' });
    assert.equal(await link.getAttribute('href'), null);
    output = 'https://coupa.ng/mock';
    await prepare.click();
    await link.waitFor({ state: 'visible' });
    assert.equal(await link.getAttribute('href'), output);
    console.log('PASS test CTA: same POST, duplicate prevention, URL validation, trusted anchor/new tab/full Referer, responsive and retry');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
