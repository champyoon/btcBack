const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ executablePath:process.env.CHROME_PATH, headless:true });
  try {
    const page = await browser.newPage({ timezoneId:'America/Los_Angeles' });
    let role = 'APPROVED', signedIn = true, attended = false;
    await page.addInitScript(() => { Date.now = () => Date.parse('2026-09-14T21:01:00Z'); });
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.hostname === 'cdn.jsdelivr.net') return route.fulfill({ contentType:'application/javascript',body:`
        window.calls=[]; window.queries=[];
        window.supabase={createClient:()=>({auth:{
          getSession:async()=>({data:{session:${signedIn}?{user:{id:'member-a',email:'long.closed.beta.account.for.mobile@example.com'}}:null}}),
          getUser:async()=>({data:{user:{id:'member-a',email_confirmed_at:'2026-09-01'}}}),
          onAuthStateChange:fn=>{window.authChange=fn;},signOut:async()=>({error:null})
        },rpc:(...args)=>{window.calls.push(args);return new Promise(resolve=>{window.resolveRpc=resolve;});},
        from:table=>{const filters={};const query={select:()=>query,eq:(key,value)=>{filters[key]=value;return query;},
          maybeSingle:async()=>{window.queries.push({table,filters});return {data:table==='profiles'?{member_status:'${role}'}:${attended}?{user_id:'member-a',source_txn_key:filters.source_txn_key,status:'CONFIRMED',amount_sats:100}:null};},
          order:()=>query,range:async()=>({data:[],count:0})};return query;}
        })};` });
      if (url.hostname !== 'btcback.test') return route.abort();
      const file = url.pathname.slice(1);
      if (file === 'admin-config.js') return route.fulfill({contentType:'application/javascript',body:'const ADMIN_SUPABASE_URL="https://pqlombgqscbacjkudirl.supabase.co";const ADMIN_SUPABASE_KEY="sb_publishable_test";'});
      if (file === 'signup.js') return route.fulfill({contentType:'application/javascript',body:''});
      return route.fulfill({contentType:file.endsWith('.js')?'application/javascript':file.endsWith('.css')?'text/css':'text/html',body:fs.readFileSync(path.join(__dirname,'..',file))});
    });
    const button = page.locator('.site-attendance-button');
    const open = async () => {
      await page.goto('https://btcback.test/index.html');
      await page.waitForFunction(()=>document.querySelector('.site-attendance-button'));
    };
    const ready = async () => page.waitForFunction(()=>{const b=document.querySelector('.site-attendance-button');return b&&!b.hidden&&!b.disabled;});
    for (const state of ['anonymous','PENDING','BLOCKED']) {
      signedIn = state !== 'anonymous'; role = state;
      await open();
      await page.waitForTimeout(100);
      assert.equal(await button.isVisible(),false);
      assert.deepEqual(await page.evaluate(()=>window.calls),[]);
    }
    signedIn=true;role='APPROVED';
    for (const name of ['index','shopping','dashboard','about','signup','terms','privacy','reward-policy','affiliate-disclosure']) {
      await page.goto('https://btcback.test/'+name+'.html');await ready();
      assert.deepEqual(await page.evaluate(()=>window.calls),[]);
    }
    await open();await ready();
    assert(await page.evaluate(()=>window.queries.some(q=>q.table==='rewards'&&q.filters.source_txn_key==='ATTENDANCE:member-a:20260915'&&q.filters.user_id==='member-a')));
    assert.equal(await page.evaluate(()=>window.queries.some(q=>q.table==='attendances')),false);
    for (const width of [320,390,768,1440]) {
      await page.setViewportSize({width,height:900});
      assert(await button.evaluate(b=>{
        const style=getComputedStyle(b);
        return style.borderRadius==='999px'&&b.getBoundingClientRect().height===34&&style.whiteSpace==='nowrap';
      }),`pill ${width}`);
      await page.locator('.site-header').screenshot({path:path.join(require('node:os').tmpdir(),`btcback-attendance-pill-${width}.png`)});
      assert(await button.evaluate(b=>{
        const box=b.getBoundingClientRect(),row=b.parentElement.getBoundingClientRect(),nav=document.querySelector('.site-nav').getBoundingClientRect();
        return box.left>=0&&box.right<=innerWidth&&row.bottom<=nav.top&&Math.abs(box.right-nav.right)<1&&document.documentElement.scrollWidth<=innerWidth;
      }),`header ${width}`);
    }
    const readyWidth = await button.evaluate(b=>b.getBoundingClientRect().width);
    await button.evaluate(b=>{b.click();b.click();});
    assert.equal(await button.evaluate(b=>b.getBoundingClientRect().width),readyWidth);
    assert.equal(await button.isDisabled(),true);
    assert.equal(await button.innerText(),'처리 중...');
    assert.deepEqual(await page.evaluate(()=>window.calls),[['check_attendance']]);
    await page.evaluate(()=>window.resolveRpc({data:{success:true,already_attended:false,reward_sats:100,attendance_date:'2026-09-15'}}));
    await page.waitForSelector('dialog[open]');
    assert.equal(await button.evaluate(b=>b.getBoundingClientRect().width),readyWidth);
    assert.equal(await page.locator('.attendance-amount').innerText(),'+100 sats');
    assert(await page.locator('.attendance-confirm').evaluate(e=>document.activeElement===e));
    for (const width of [320,390,768,1440]) {
      await page.setViewportSize({width,height:900});
      assert(await page.locator('dialog').evaluate(d=>{const r=d.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.bottom<=innerHeight&&d.scrollWidth<=d.clientWidth;}));
      await page.screenshot({path:path.join(require('node:os').tmpdir(),`btcback-attendance-${width}.png`)});
    }
    attended=true;
    await page.click('.attendance-confirm');await page.waitForURL('**/dashboard.html');
    await page.waitForFunction(()=>document.querySelector('.site-attendance-button')?.textContent==='오늘 출석 완료 ✓');
    await page.reload();await page.waitForFunction(()=>document.querySelector('.site-attendance-button')?.textContent==='오늘 출석 완료 ✓');
    assert.equal(await button.isDisabled(),true);
    assert.deepEqual(await page.evaluate(()=>window.calls),[]);
    attended=false;
    for (const result of [
      {data:{success:true,already_attended:true,reward_sats:0,attendance_date:'2026-09-15'}},
      {error:{message:'PRIVATE_ERROR_DO_NOT_RENDER'}},
      {data:{success:true,already_attended:false,reward_sats:999,attendance_date:'2026-09-15'}}
    ]) {
      await open();await ready();await button.click();
      await page.evaluate(r=>window.resolveRpc(r),result);await page.waitForSelector('dialog[open]');
      assert.equal(await page.locator('.attendance-amount').isVisible(),false);
      assert(!(await page.locator('dialog').innerText()).includes('PRIVATE_ERROR'));
      if(result.data?.already_attended) assert.equal(await button.innerText(),'오늘 출석 완료 ✓');
      else assert((await page.locator('dialog').innerText()).includes('실패'));
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('dialog').isVisible(),false);
      assert.equal(new URL(page.url()).pathname,'/index.html');
    }
    await open();await ready();await button.click();
    await page.evaluate(()=>window.authChange('SIGNED_OUT'));
    await page.evaluate(()=>window.resolveRpc({data:{success:true,already_attended:false,reward_sats:100,attendance_date:'2026-09-15'}}));
    assert.equal(await button.isVisible(),false);
    assert.equal(await page.locator('dialog').isVisible(),false);
    console.log('PASS attendance UI: APPROVED gate, own-row initial read, no-arg RPC, duplicate prevention, success/redirect, repeat/reload, errors, logout races, focus/ESC and four viewports');
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
