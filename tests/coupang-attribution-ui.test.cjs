const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  try {
    const page = await browser.newPage({ timezoneId: 'America/Los_Angeles' });
    await page.addInitScript(() => { Date.now = () => Date.parse('2026-09-09T01:38:25Z'); });
    let mode = 'failure', calls = 0, release;
    const short = 'https://link.coupang.com/a/test';
    await page.route('**/*', async route => {
      const url = route.request().url();
      if (url === 'https://btcback.test/shopping.html') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(__dirname, '../shopping.html'), 'utf8') });
      if (url === 'https://btcback.test/coupang-attribution.js') return route.fulfill({ contentType: 'text/javascript', body: fs.readFileSync(path.join(__dirname, '../coupang-attribution.js'), 'utf8') });
      if (url === 'https://btcback.test/partner-selector.js') return route.fulfill({ contentType: 'text/javascript', body: fs.readFileSync(path.join(__dirname, '../partner-selector.js'), 'utf8') });
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
    assert.equal(await page.locator('#SB19739155').getAttribute('src'), null);
    assert.equal(await page.locator('[role="tab"]').count(), 8);
    assert.equal(await page.locator('.hero-benefits').count(), 0);
    assert.equal(await page.locator('.partner-tab .status').count(), 6);
    assert.equal(await page.locator('#tab-coupang').getAttribute('aria-selected'), 'true');
    for (const partner of ['trip', 'iherb', 'oliveyoung', 'lego', 'agoda', 'booking', 'eleven', 'coupang']) {
      await page.locator('#tab-' + partner).click();
      assert.ok(await page.locator('#panel-' + partner).isVisible());
      if (partner === 'trip') {
        const src = new URL(await page.locator('#SB19739155').getAttribute('src'));
        assert.equal(src.origin + src.pathname, 'https://kr.trip.com/partners/ad/SB19739155');
        assert.deepEqual([...src.searchParams], [['Allianceid', '10473870'], ['SID', '330569310'], ['trip_sub1', '260909103825']]);
        assert.match(src.searchParams.get('trip_sub1'), /^\d{12}$/);
        assert.equal(await page.locator('#SB19739155').getAttribute('width'), '728');
        assert.equal(await page.locator('#SB19739155').getAttribute('height'), '90');
      }
      assert.equal(await page.locator('[role="tabpanel"]:visible').count(), 1);
      if (['iherb', 'oliveyoung', 'lego', 'agoda', 'booking', 'eleven'].includes(partner)) assert.equal(await page.locator('#panel-' + partner + ' a, #panel-' + partner + ' button').count(), 0);
    }
    await page.locator('#tab-coupang').focus();
    await page.evaluate(() => { Date.now = () => Date.parse('2026-09-10T01:38:25Z'); });
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.locator('#tab-trip').getAttribute('aria-selected'), 'true');
    assert.equal(new URL(await page.locator('#SB19739155').getAttribute('src')).searchParams.get('trip_sub1'), '260909103825');
    await page.keyboard.press('End');
    assert.ok(await page.locator('#panel-eleven').isVisible());
    await page.keyboard.press('Home');
    assert.ok(await page.locator('#panel-coupang').isVisible());
    assert.equal(await page.locator('.attribution-test, #attribution-url, iframe[src="https://coupa.ng/cpi1Ss"]').count(), 0);
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.locator('#tab-trip').click();
      const bounds = await page.locator('#SB19739155').boundingBox();
      assert.ok(bounds.width <= 728 && bounds.x >= 0 && bounds.x + bounds.width <= width);
      assert.equal(bounds.height, 90);
      await page.locator('#tab-coupang').click();
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
