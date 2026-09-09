const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  try {
    const page = await browser.newPage();
    let mode = 'failure', calls = 0, release;
    const short = 'https://link.coupang.com/a/test';
    await page.route('**/*', async route => {
      const url = route.request().url();
      if (url === 'https://btcback.test/shopping.html') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(__dirname, '../shopping.html'), 'utf8') });
      if (url === 'https://btcback.test/coupang-attribution.js') return route.fulfill({ contentType: 'text/javascript', body: fs.readFileSync(path.join(__dirname, '../coupang-attribution.js'), 'utf8') });
      if (url === short) return route.fulfill({ contentType: 'text/html', body: '<p>Mock destination</p>' });
      if (url.includes('/functions/v1/coupang-deeplink')) {
        calls++;
        assert.deepEqual(route.request().postDataJSON(), { coupangUrl: 'https://www.coupang.com/' });
        if (mode === 'delayed') await new Promise(resolve => { release = resolve; });
        return route.fulfill({ status: mode === 'failure' ? 502 : 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ success: mode !== 'failure', shortenUrl: mode === 'unsafe' ? 'https://evil.test' : short, landingUrl: 'https://link.coupang.com/re/AFFSDP?subid=btcback_test_001' }) });
      }
      return route.abort();
    });
    await page.goto('https://btcback.test/shopping.html');
    assert.equal(await page.locator('.attribution-test, #attribution-url, iframe[src="https://coupa.ng/cpi1Ss"]').count(), 0);
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    }
    for (const nextMode of ['failure', 'unsafe']) {
      mode = nextMode;
      await page.locator('#coupang-entry').click();
      await page.waitForFunction(() => !document.getElementById('coupang-entry').disabled);
      assert.ok((await page.locator('#coupang-entry-status').textContent()).length > 0);
      assert.equal(page.url(), 'https://btcback.test/shopping.html');
    }
    mode = 'delayed';
    await page.locator('#coupang-entry').click();
    await page.waitForFunction(() => document.getElementById('coupang-entry').disabled);
    await page.evaluate(() => document.getElementById('coupang-entry').dispatchEvent(new MouseEvent('click')));
    assert.equal(calls, 3);
    while (!release) await new Promise(resolve => setTimeout(resolve, 10));
    release();
    await page.waitForURL(short);
    assert.equal(calls, 3);
    console.log('PASS home deeplink CTA: responsive widths, fixed body, failure/retry, unsafe URL denial, duplicate prevention and shortenUrl navigation');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
