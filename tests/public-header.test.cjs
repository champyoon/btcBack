const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const pages = ['index','shopping','dashboard','about','login','signup','terms','privacy','reward-policy','affiliate-disclosure'];
(async () => {
  const browser = await chromium.launch({ executablePath:process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless:true });
  try {
    const page = await browser.newPage();
    let signedIn = false;
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.hostname === 'cdn.jsdelivr.net') return route.fulfill({ contentType:'application/javascript', body:`
        window.supabase={createClient:(url,key,options)=>({auth:{
          getSession:async()=>({data:{session:${signedIn} ? {user:{id:'test-user'}} : null}}),
          getUser:async()=>({data:{user:{id:'test-user',email_confirmed_at:'2026-09-09'}}}),
          onAuthStateChange:()=>{},signOut:async(options)=>{window.logoutOptions=options;return {error:null};}
        },from:()=>({select:()=>({eq:()=>({maybeSingle:async()=>({data:{member_status:'PENDING'}})})})})})};` });
      if (url.hostname !== 'btcback.test') return route.abort();
      const file = url.pathname.slice(1);
      // Signup verification and affiliate scripts have separate regression suites.
      if (file === 'signup.js' || /shopping.*\.js$/.test(file)) return route.fulfill({contentType:'application/javascript',body:''});
      if (file === 'admin-config.js') return route.fulfill({contentType:'application/javascript',body:'const ADMIN_SUPABASE_URL="https://pqlombgqscbacjkudirl.supabase.co";const ADMIN_SUPABASE_KEY="sb_publishable_test";'});
      return route.fulfill({contentType:file.endsWith('.js')?'application/javascript':file.endsWith('.css')?'text/css':'text/html',body:fs.readFileSync(path.join(__dirname,'..',file))});
    });
    for (const state of [false,true]) {
      signedIn = state;
      for (const name of pages) {
        await page.goto('https://btcback.test/'+name+'.html');
        if (name === 'dashboard' && !state) await page.waitForURL('**/login.html');
        const action = state ? '#member-logout' : '.site-auth-entry';
        await page.waitForSelector(action);
        assert.equal(await page.locator('.site-auth-slot').count(),1);
        assert.equal(await page.locator(action).innerText(),state?'로그아웃':'로그인');
        assert.equal(await page.locator('.site-nav > a').count(),4);
        assert.equal(await page.locator('main #member-logout').count(),0);
        assert.equal(await page.locator('body > .member-access #member-logout').count(),0);
        if (!state) assert.equal(await page.locator(action).getAttribute('href'),'login.html');
        const active = {index:'홈',shopping:'쇼핑하기',dashboard:'My BTCBack',about:'BTCBack은?'}[name];
        if (active && !(name === 'dashboard' && !state)) assert.equal(await page.locator('.site-nav [aria-current="page"]').innerText(),active);
        for (const width of [320,390,768,1440]) {
          await page.setViewportSize({width,height:900});
          assert(await page.locator('.site-nav').evaluate(nav => {
            const boxes=[...nav.querySelectorAll('a,button')].filter(e=>e.getClientRects().length).map(e=>e.getBoundingClientRect());
            return boxes.every((a,i)=>a.left>=0 && a.right<=innerWidth && a.height>=39 && boxes.every((b,j)=>i===j || a.right<=b.left || b.right<=a.left || a.bottom<=b.top || b.bottom<=a.top));
          }), `${name} ${width} header overflow/overlap`);
          if (state && name === 'about' && [320,1440].includes(width)) await page.screenshot({path:path.join(require('node:os').tmpdir(),`btcback-header-${width}.png`)});
        }
      }
    }
    await page.goto('https://btcback.test/about.html');
    await page.waitForSelector('#member-logout');
    signedIn = false;
    await page.click('#member-logout');
    await page.waitForURL('**/login.html');
    await page.waitForSelector('.site-auth-entry');
    assert.match(fs.readFileSync(path.join(__dirname,'..','member-auth.js'),'utf8'),/signOut\(\{ scope: 'local' \}\)/);
    console.log('PASS public headers: 10 pages, session states, active nav, header-only logout, 320/390/768/1440 layout');
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
