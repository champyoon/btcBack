const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.join(__dirname, '..');
const mock = `
window.user = null; window.authCallback = () => {}; window.failUpdate = false; window.conflict = false;
window.updates = 0; window.privateReads = 0; window.lastUpdate = null;
function query(table) {
 if(table!=='admin_users') throw new Error('Unexpected table');
 const q={select:()=>q,eq:()=>q,maybeSingle:async()=>({data:user?.id==='admin'?{user_id:'admin'}:null,error:null})};return q;
}
window.supabase = {createClient:()=>({from:query,auth:{
  getUser:async()=>({data:{user},error:null}),
  onAuthStateChange:callback=>{window.authCallback=callback;},
  signInWithPassword:async({email,password})=>{
    if(password==='wrong') return {error:{code:'invalid_credentials'}};
    window.user={id:email.startsWith('outsider')?'outsider':'admin',email};
    authCallback('SIGNED_IN'); return {data:{user},error:null};
  },
  signOut:async()=>{window.user=null;authCallback('SIGNED_OUT');return {error:null};}
}})};
`;
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true });
  try {
    const page = await browser.newPage(); const errors=[];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('https://btcback.test/**', route => {
      const file = new URL(route.request().url()).pathname.slice(1);
      const body = file==='admin-config.js' ? "const ADMIN_SUPABASE_URL='https://mock.supabase.co';const ADMIN_SUPABASE_KEY='sb_publishable_test';" : fs.readFileSync(path.join(root,file),'utf8');
      return route.fulfill({contentType:file.endsWith('.html')?'text/html':'application/javascript',body});
    });
    await page.route('https://cdn.jsdelivr.net/**', route=>route.fulfill({contentType:'application/javascript',body:mock}));
    const login = async (email='admin@example.com',password='test-password') => {
      await page.fill('#email',email); await page.fill('#password',password); await page.click('#login-button');
    };
    await page.goto('https://btcback.test/admin.html');
    assert.equal(await page.locator('#dashboard').isVisible(),false);
    await login('admin@example.com','wrong');
    await page.waitForFunction(()=>!document.getElementById('auth-message').hidden);
    await login('outsider@example.com');
    await page.waitForFunction(()=>document.getElementById('auth-message').textContent.includes('등록되지'));
    assert.equal(await page.evaluate(()=>privateReads),0);
    await login(); await page.locator('#dashboard').waitFor({state:'visible'});
    assert.equal(await page.locator('#requests').count(),0);
    assert.equal(await page.evaluate(()=>privateReads),0);
    for (const width of [320,390,768,1440]) {
      await page.setViewportSize({width,height:900});
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    }
    await page.evaluate(()=>{user={id:'outsider',email:'other@example.com'};authCallback('TOKEN_REFRESHED');});
    await page.locator('#dashboard').waitFor({state:'hidden'});
    await login(); await page.locator('#dashboard').waitFor({state:'visible'});
    await page.click('#logout'); await page.locator('#dashboard').waitFor({state:'hidden'});
    assert.deepEqual(errors,[]);
    console.log('PASS admin login, non-admin denial, revocation, logout and responsive shell');
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
