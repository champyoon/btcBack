const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const html = fs.readFileSync(path.join(__dirname, '..', 'reward.html'), 'utf8')
  .replace(/const SUPABASE_URL = '[^']*';/, "const SUPABASE_URL = 'YOUR_SUPABASE_URL';")
  .replace(/const SUPABASE_ANON_KEY = '[^']*';/, "const SUPABASE_ANON_KEY = 'YOUR_SUPABASE_ANON_KEY';");
const anonKey = `test.${Buffer.from(JSON.stringify({ role: 'anon' })).toString('base64url')}.test`;
const configured = html.replace('YOUR_SUPABASE_URL', 'https://test.supabase.co')
  .replace('YOUR_SUPABASE_ANON_KEY', anonKey);

// Mock only the external client boundary; run the page's real validation and UI.
const client = `window.calls = []; window.reply = { error: null, status: 201 };
window.supabase = { createClient: () => ({ from: table => ({ insert: payload => ({
  abortSignal: signal => new Promise(resolve => {
    window.calls.push({table, payload});
    const timer = setTimeout(() => resolve(window.reply), window.delay || 0);
    signal.addEventListener('abort', () => { clearTimeout(timer); resolve({error: {code: ''}, status: 0}); });
  })
}) }) }) };`;

(async () => {
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: true
  });
  try {
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    let source = configured;
    let cdnFails = false;
    await page.route('https://btcback.test/reward.html', route => route.fulfill({ contentType: 'text/html', body: source }));
    await page.route('https://cdn.jsdelivr.net/**', route => cdnFails ? route.abort() : route.fulfill({ contentType: 'application/javascript', body: client }));
    const open = () => page.goto('https://btcback.test/reward.html');
    const fill = async () => {
      await page.selectOption('#store', 'coupang');
      await page.fill('#purchase-date', '2026-01-01');
      await page.fill('#amount', '52,000');
      await page.fill('#nickname', 'Test');
      await page.fill('#email', 'test@example.com');
      await page.fill('#lightning', 'test@wallet.com');
    };
    await open();
    assert.equal(await page.locator('#store option').count(), 1);
    assert.equal(await page.locator('#store option').textContent(), '쿠팡');
    await page.click('#submit-button');
    assert.equal(await page.locator('[aria-invalid="true"]').count(), 5);
    assert.equal(await page.evaluate(() => calls.length), 0);
    await fill();
    await page.fill('#amount', '-1');
    await page.click('#submit-button');
    assert.equal(await page.evaluate(() => calls.length), 0);
    await page.fill('#amount', '52,000');
    await page.evaluate(() => {
      window.delay = 500;
      const option = document.querySelector('#store option');
      option.value = 'tampered';
      option.textContent = 'Amazon';
    });
    await page.evaluate(() => {
      const form = document.getElementById('reward-form');
      form.requestSubmit(); form.requestSubmit();
    });
    assert.equal(await page.locator('#submit-button').isDisabled(), true);
    await page.locator('#success').waitFor({ state: 'visible' });
    const calls = await page.evaluate(() => window.calls);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], { table: 'reward_requests', payload: {
      store_name: '쿠팡', purchase_date: '2026-01-01', purchase_amount: 52000,
      order_number: null, customer_name: 'Test', email: 'test@example.com',
      lightning_destination: 'test@wallet.com', memo: null
    } });
    assert.equal(await page.locator('#reward-form').isVisible(), false);
    console.log('PASS validation, numeric amount, null optional fields, single insert, success');

    for (const status of [403, 0, 500]) {
      await open(); await fill();
      await page.evaluate(status => { window.reply = { error: { code: '42501' }, status }; }, status);
      await page.click('#submit-button');
      await page.locator('#submit-error').waitFor({ state: 'visible' });
      assert.equal(await page.locator('#success').isVisible(), false);
      assert.equal(await page.locator('#amount').inputValue(), '52,000');
      assert.equal(await page.locator('#submit-button').isEnabled(), true);
    }
    // A retry after a confirmed failure can succeed, including the invoice input.
    await page.evaluate(() => { window.reply = { error: null, status: 201 }; });
    await page.fill('#lightning', 'lnbc1' + 'q'.repeat(110));
    await page.fill('#order', 'ORDER-TEST');
    await page.fill('#memo', 'Test memo');
    await page.click('#submit-button');
    await page.locator('#success').waitFor({ state: 'visible' });
    assert.equal(await page.evaluate(() => calls.at(-1).payload.order_number), 'ORDER-TEST');
    console.log('PASS permission/network/server errors, preserved values, retry, invoice format');

    source = configured.replace(anonKey, 'sb_publishable_test_public_key');
    await open(); await fill();
    assert.equal(await page.locator('#submit-button').isEnabled(), true);
    await page.click('#submit-button');
    await page.locator('#success').waitFor({ state: 'visible' });
    assert.equal(await page.evaluate(() => calls.length), 1);
    source = configured.replace(anonKey, 'sb_secret_test_secret_key');
    await open();
    assert.equal(await page.locator('#submit-button').isDisabled(), true);
    console.log('PASS publishable key submission and secret key rejection');

    source = html;
    await open();
    assert.equal(await page.locator('#submit-button').isDisabled(), true);
    assert.equal(await page.locator('#submit-error').isVisible(), true);
    source = configured.replace(anonKey, `test.${Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url')}.test`);
    await open();
    assert.equal(await page.locator('#submit-button').isDisabled(), true);
    source = configured; cdnFails = true;
    await open();
    assert.equal(await page.locator('#submit-button').isDisabled(), true);
    cdnFails = false;
    console.log('PASS missing configuration, privileged key rejection, CDN failure');

    for (const width of [1920, 768, 390, 320]) {
      await page.setViewportSize({ width, height: 1080 }); await open();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    }
    assert.deepEqual(pageErrors, []);
    console.log('PASS responsive widths and no uncaught page errors');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
