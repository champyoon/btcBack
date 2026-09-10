const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const [mode, directory] = process.argv.slice(2);
if (!['capture','compare'].includes(mode) || !directory) throw new Error('Usage: node scripts/check-css-visual.cjs capture|compare BASELINE_DIRECTORY');
const root = path.join(__dirname, '..');
const baseline = path.resolve(directory);
const pages = ['index','shopping','dashboard','about','login','signup','terms','privacy','reward-policy','affiliate-disclosure'];
const scenarios = pages.map(page=>({page,state:page==='dashboard'?'APPROVED':null})).concat(
  ['index','shopping','about'].map(page=>({page,state:'APPROVED'})),
  ['PENDING','BLOCKED'].map(state=>({page:'login',state})),
  [{page:'shopping',state:null,partner:'trip'},{page:'shopping',state:null,partner:'iherb'}]);
(async()=>{
  if (mode==='capture') { assert(!fs.existsSync(baseline),'Use a new baseline directory'); fs.mkdirSync(baseline,{recursive:true}); }
  const browser = await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH});
  try {
    let current;
    const page = await browser.newPage();
    await page.addInitScript(()=>{Date.now=()=>Date.parse('2026-09-09T01:38:25Z');});
    await page.route('**/*', route=>{
      const url = new URL(route.request().url());
      if (url.hostname==='cdn.jsdelivr.net') return route.fulfill({contentType:'application/javascript',body:`window.supabase={createClient:()=>({auth:{getSession:async()=>({data:{session:${Boolean(current.state)}?{}:null}}),getUser:async()=>({data:{user:{id:'mock',email_confirmed_at:'2026-09-09'}}}),onAuthStateChange:()=>{}},from:()=>({select:()=>({eq:()=>({maybeSingle:async()=>({data:{member_status:${JSON.stringify(current.state)}}})})})})})};`});
      if (url.hostname==='kr.trip.com') return route.fulfill({contentType:'text/html',body:'<!doctype html><body style="margin:0;background:#ddd">Trip banner fixture</body>'});
      if (url.hostname!=='btcback.test') return route.abort();
      const file = url.pathname.slice(1);
      if (file==='admin-config.js') return route.fulfill({contentType:'application/javascript',body:'const ADMIN_SUPABASE_URL="https://pqlombgqscbacjkudirl.supabase.co";const ADMIN_SUPABASE_KEY="sb_publishable_test";'});
      return route.fulfill({contentType:file.endsWith('.js')?'application/javascript':file.endsWith('.css')?'text/css':'text/html',body:fs.readFileSync(path.join(root,file))});
    });
    let count=0;
    for (const scenario of scenarios) for (const width of [320,390,768,1440]) {
      current=scenario;
      await page.setViewportSize({width,height:900});
      await page.goto(`https://btcback.test/${scenario.page}.html`);
      await page.waitForSelector(scenario.state?'#member-logout':'.site-auth-entry');
      if (scenario.page==='dashboard') await page.waitForSelector('#member-dashboard');
      if (scenario.partner) await page.click(`[role="tab"][data-partner="${scenario.partner}"]`);
      await page.evaluate(()=>document.fonts.ready);
      await page.waitForTimeout(100);
      const id=`${scenario.page}-${scenario.state||'anon'}-${scenario.partner||'default'}-${width}`;
      const metrics=await page.evaluate(()=>{
        const selectors=['.site-header','.site-nav','footer','.brand-message','.step-card','.partner-card','.earned','form','.policy-links'];
        return {overflow:document.documentElement.scrollWidth>innerWidth,boxes:selectors.flatMap(selector=>[...document.querySelectorAll(selector)].map(e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return {selector,x:r.x,y:r.y,width:r.width,height:r.height,display:s.display,font:s.font,color:s.color};}))};
      });
      assert(!metrics.overflow,`${id}: horizontal overflow`);
      const screenshot=await page.screenshot({fullPage:true,animations:'disabled'});
      const png=path.join(baseline,id+'.png'),json=path.join(baseline,id+'.json');
      if(mode==='capture'){fs.writeFileSync(png,screenshot);fs.writeFileSync(json,JSON.stringify(metrics));}
      else {
        assert.deepEqual(metrics,JSON.parse(fs.readFileSync(json)),`${id}: layout/style changed`);
        if(!screenshot.equals(fs.readFileSync(png))) { fs.writeFileSync(path.join(baseline,id+'-actual.png'),screenshot); throw new Error(`${id}: screenshot differs`); }
      }
      count++;
    }
    console.log(`PASS ${mode}: ${count} full-page screenshots and layout metrics (mock Auth/Trip, no live API)`);
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
