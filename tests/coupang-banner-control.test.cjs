const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const href = 'https://link.coupang.com/a/gY9mXfjiZE';
    const src = 'https://ads-partners.coupang.com/banners/1026300?trackingCode=AF7466415&subId=&traceId=V0-301-879dd1202e5c73b2-I1026300&w=728&h=90';
    let apiCalls = 0, navigations = 0;
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.pathname.includes('/functions/v1/') || url.hostname === 'api-gateway.coupang.com') { apiCalls++; return route.abort(); }
      if (url.href === href) { navigations++; return route.fulfill({ contentType: 'text/html', body: 'Mock control destination' }); }
      if (url.href === src) return route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1kAAAAASUVORK5CYII=', 'base64') });
      if (url.hostname === 'btcback.test') {
        const file = url.pathname.slice(1);
        if (file === 'admin-config.js' || file === 'member-auth.js') return route.abort();
        return route.fulfill({ contentType: file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : 'text/html', body: fs.readFileSync(path.join(__dirname, '..', file)) });
      }
      return route.abort();
    });
    await page.goto('https://btcback.test/shopping.html');
    const anchor = page.locator('#coupang-test-d a');
    assert.equal(await anchor.getAttribute('href'), href);
    assert.equal(await anchor.getAttribute('target'), '_blank');
    assert.equal(await anchor.getAttribute('referrerpolicy'), 'unsafe-url');
    assert.equal(await anchor.locator('img').getAttribute('src'), src);
    assert.equal(await anchor.locator('img').getAttribute('alt'), '');
    assert.equal(new URL(await anchor.getAttribute('href')).search, '');
    for (const width of [320,390,768,1440]) {
      await page.setViewportSize({ width, height: 900 });
      const box = await anchor.locator('img').boundingBox();
      assert(box.x >= 0 && box.x + box.width <= width && box.width <= 728);
      assert(Math.abs(box.width / box.height - 728 / 90) < 0.02);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      if ([390,1440].includes(width)) await page.locator('#panel-coupang').screenshot({ path: path.join(require('node:os').tmpdir(), `btcback-cd-${width}.png`) });
    }
    const popupPromise = page.waitForEvent('popup');
    await anchor.click();
    const popup = await popupPromise;
    await popup.waitForLoadState();
    assert.equal(popup.url(), href);
    assert.equal(page.url(), 'https://btcback.test/shopping.html');
    assert.equal(navigations, 1);
    assert.equal(apiCalls, 0);
    console.log('PASS D: official HTML URLs, single native click, no API, responsive banner');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
