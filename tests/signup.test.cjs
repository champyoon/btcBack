const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.join(__dirname, '..');
const mock = `window.calls=[];window.reads=[];window.reply={data:{session:null},error:null};window.profile={data:{member_status:'PENDING'},error:null};
window.supabase={createClient:(url,key,options)=>{if(options.auth.storageKey==='btcback-member-auth')return {auth:{getSession:async()=>({data:{session:null}}),onAuthStateChange:()=>{}}};window.options=options;return {
auth:{signUp:async args=>{window.calls.push(args);await new Promise(r=>setTimeout(r,window.delay||0));if(window.reject)throw Error('network');return window.reply;},setSession:async()=>({error:null}),getUser:async()=>({data:{user:{id:'test-user',email_confirmed_at:'2026-09-09'}}})},
from:table=>{window.reads.push(table);if(table!=='profiles')throw Error('unexpected write');return {select:()=>({eq:()=>({maybeSingle:async()=>window.profile})})}}
}}};`;
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true });
  try {
    const page = await browser.newPage();
    let cdnFails = false;
    await page.route('https://btcback.test/**', route => {
      const file = new URL(route.request().url()).pathname.slice(1);
      if (file === 'admin-config.js') return route.fulfill({ contentType:'application/javascript', body:'const ADMIN_SUPABASE_URL="https://pqlombgqscbacjkudirl.supabase.co";const ADMIN_SUPABASE_KEY="sb_publishable_test";' });
      return route.fulfill({ contentType:file.endsWith('.js')?'application/javascript':file.endsWith('.css')?'text/css':'text/html', body:fs.readFileSync(path.join(root,file),'utf8') });
    });
    await page.route('https://cdn.jsdelivr.net/**', r => cdnFails ? r.abort() : r.fulfill({ contentType:'application/javascript',body:mock }));
    const open = async hash => {
      await page.goto('about:blank');
      return page.goto('https://btcback.test/signup.html'+(hash||''));
    };
    const fill = async () => {
      await page.fill('#email','test@example.com'); await page.fill('#password','Example-password-123!');
      await page.fill('#password-confirm','Example-password-123!');await page.check('#terms');await page.check('#privacy-collection');
    };
    await open();
    assert.equal(await page.locator('input[type=password]').count(),2);
    assert.equal(await page.locator('input[type=checkbox][required]').count(),2);
    assert.equal(await page.locator('form a[href="terms.html"]').count(),1);
    await page.click('#submit');assert.equal(await page.evaluate(()=>calls.length),0);
    await fill();await page.uncheck('#terms');await page.click('#submit');assert.equal(await page.evaluate(()=>calls.length),0);
    await page.check('#terms');await page.fill('#password-confirm','different');await page.click('#submit');assert.equal(await page.evaluate(()=>calls.length),0);
    await page.fill('#password-confirm','Example-password-123!');await page.evaluate(()=>window.delay=150);
    await page.click('#submit');await page.locator('form').evaluate(e=>e.dispatchEvent(new Event('submit',{cancelable:true})));
    await page.waitForFunction(()=>document.querySelector('form').hidden);
    assert.equal(await page.evaluate(()=>calls.length),1);
    assert.equal(await page.evaluate(()=>calls[0].options.emailRedirectTo),'https://btcback.kr/signup.html');
    assert.equal(await page.inputValue('#password'),'');
    assert.equal(await page.evaluate(()=>options.auth.persistSession),false);
    assert.equal(await page.evaluate(()=>localStorage.length+sessionStorage.length),0);
    for (const [email, masked] of [['champyoon@gmail.com','cha******@gmail.com'],['abc@gmail.com','a**@gmail.com'],['ab@gmail.com','a*@gmail.com'],['a@gmail.com','*@gmail.com']]) {
      let normal;
      for (const duplicate of [false,true]) {
        await open();await fill();await page.fill('#email',email);
        if(duplicate)await page.evaluate(()=>window.reply={error:{code:'user_already_exists'}});
        await page.click('#submit');await page.waitForSelector('form[hidden]',{state:'attached'});
        const notice=await page.innerText('#message');assert(notice.includes(masked));assert(!notice.includes(email));
        if(duplicate)assert.equal(notice,normal);else normal=notice;
        assert.equal(await page.evaluate(()=>localStorage.length+sessionStorage.length),0);
        assert.equal(new URL(page.url()).search,'');assert.equal(new URL(page.url()).hash,'');
        assert.deepEqual(await page.evaluate(()=>reads),[]);
        assert.equal(await page.evaluate(()=>calls[0].email),email);
      }
    }
    for(const reply of [{error:{code:'weak_password'}},{error:{status:429}},{error:{code:'unexpected'}},{data:{session:{}}}]){
      await open();await fill();await page.evaluate(r=>window.reply=r,reply);await page.click('#submit');await page.waitForSelector('.message.error');
      assert.equal(await page.inputValue('#password'),'');
    }
    await open();await fill();await page.evaluate(()=>window.reject=true);await page.click('#submit');await page.waitForSelector('.message.error');assert.equal(await page.isDisabled('#submit'),false);
    await open();await fill();await page.evaluate(()=>window.reply={error:{code:'user_already_exists'}});await page.click('#submit');await page.waitForSelector('form[hidden]',{state:'attached'});assert(!(await page.innerText('#message')).includes('이미 가입'));
    await open('#access_token=test&refresh_token=test&type=signup');await page.waitForFunction(()=>document.querySelector('#message').textContent.includes('참여 승인'));
    assert.equal(new URL(page.url()).hash,'');assert.equal(await page.evaluate(()=>localStorage.length+sessionStorage.length),0);
    await open('#error=access_denied&error_description=private');await page.waitForSelector('.message.error');assert(!(await page.innerText('#message')).includes('private'));
    cdnFails=true;await open();await page.waitForSelector('.message.error');assert(await page.isDisabled('#submit'));cdnFails=false;
    for(const width of [320,390,768,1440]){await page.setViewportSize({width,height:900});await open();assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));}
    const js=fs.readFileSync(path.join(root,'signup.js'),'utf8');assert(!/\.insert\(|console\./.test(js));
    console.log('PASS signup validation, consent gates, duplicate prevention, safe errors, non-enumeration, callback, no persistence, CDN failure, responsive');
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
