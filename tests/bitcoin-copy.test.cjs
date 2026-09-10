const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.join(__dirname, '..');
(async () => {
  const browser = await chromium.launch({executablePath:process.env.CHROME_PATH,headless:true});
  try {
    const page = await browser.newPage();
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.hostname === 'cdn.jsdelivr.net') return route.fulfill({contentType:'application/javascript',body:`window.supabase={createClient:()=>({auth:{getSession:async()=>({data:{session:{}}}),getUser:async()=>({data:{user:{id:'demo',email_confirmed_at:'2026-09-09'}}}),onAuthStateChange:()=>{}},from:()=>({select:()=>({eq:()=>({maybeSingle:async()=>({data:{member_status:'APPROVED'}})})})})})};`});
      if (url.hostname !== 'btcback.test') return route.abort();
      const file = url.pathname.slice(1);
      if (file === 'admin-config.js') return route.fulfill({contentType:'application/javascript',body:'const ADMIN_SUPABASE_URL="https://pqlombgqscbacjkudirl.supabase.co";const ADMIN_SUPABASE_KEY="sb_publishable_test";'});
      return route.fulfill({contentType:file.endsWith('.js')?'application/javascript':file.endsWith('.css')?'text/css':'text/html',body:fs.readFileSync(path.join(root,file))});
    });
    for (const name of ['index','dashboard']) {
      const html = fs.readFileSync(path.join(root,name+'.html'),'utf8');
      assert(!html.includes('Shop. Earn sats. Stack Bitcoin.'));
      for (const width of [320,390,768,1440]) {
        await page.setViewportSize({width,height:1000});
        await page.goto('https://btcback.test/'+name+'.html');
        await page.waitForSelector('.brand-message');
        assert.equal(await page.locator('.brand-message').innerText(),'Shop. Earn Bitcoin.');
        assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
        if (name === 'index') {
          assert.equal(await page.locator('.step-number').nth(1).innerText(),'02 / EARN BITCOIN');
          assert(await page.locator('.brand-message').evaluate(e=>{const range=document.createRange();range.selectNodeContents(e);const a=range.getBoundingClientRect(),b=e.parentElement.getBoundingClientRect();return Math.abs(a.x+a.width/2-b.x-b.width/2)<1;}));
          assert(await page.locator('.step-number').nth(1).evaluate(e=>{const range=document.createRange();range.selectNodeContents(e);const a=range.getBoundingClientRect(),b=e.parentElement.getBoundingClientRect();return a.left>=b.left && a.right<=b.right;}));
        } else {
          assert.equal(await page.locator('#earned-title').innerText(),'Bitcoin Earned');
          assert.match(await page.locator('.sats-total').innerText(),/87,420\s+sats/);
          assert((await page.locator('main').innerText()).includes('0.00087420 BTC'));
          assert.equal(await page.locator('.demo-badge').innerText(),'DEMO');
        }
        if (width===390 || width===1440) await page.screenshot({path:path.join(require('node:os').tmpdir(),`btcback-copy-${name}-${width}.png`)});
      }
    }
    assert(fs.readFileSync(path.join(root,'reward-policy.html'),'utf8').includes('지급할 sats 수량'));
    console.log('PASS Bitcoin concept copy, retained sats/BTC quantities, DEMO and 320/390/768/1440 layout');
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
