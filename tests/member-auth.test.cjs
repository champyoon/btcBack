const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.join(__dirname, '..');
const mock = `window.supabase={createClient:(url,key,options)=>{window.options=options;window.calls=[];let cb;return {
auth:{getSession:async()=>({data:{session:window.session?{user:{id:'u'}}:null}}),getUser:async()=>({data:{user:{id:'u',email_confirmed_at:'2026-09-09'}}}),
signInWithPassword:async x=>{window.calls.push(['login',x]);if(window.loginError)return {error:window.loginError};window.session=true;return {error:null}},
signOut:async x=>{window.calls.push(['logout',x]);if(window.logoutError)return {error:{}};window.session=false;cb('SIGNED_OUT');return {error:null}},onAuthStateChange:f=>{cb=f;window.emit=f}},
from:t=>({select:cols=>({eq:(key,id)=>({maybeSingle:async()=>{window.calls.push(['profile',t,cols,key,id]);return window.profileError?{error:{}}:{data:window.member===null?null:{member_status:window.member}}}})})})}}};`;
(async()=>{
 const b=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 try {
  const p=await b.newPage();let initialSession=false,member='PENDING',cdnFails=false;
  await p.addInitScript(()=>{window.session=false;});
  await p.route('https://btcback.test/**',r=>{const f=new URL(r.request().url()).pathname.slice(1);if(f==='admin-config.js')return r.fulfill({contentType:'application/javascript',body:'const ADMIN_SUPABASE_URL="https://pqlombgqscbacjkudirl.supabase.co";const ADMIN_SUPABASE_KEY="sb_publishable_test";'});if(f==='shopping.html')return r.fulfill({contentType:'text/html',body:'<h1>Shopping destination</h1>'});return r.fulfill({contentType:f.endsWith('.js')?'application/javascript':f.endsWith('.css')?'text/css':'text/html',body:fs.readFileSync(path.join(root,f),'utf8')});});
  await p.route('https://cdn.jsdelivr.net/**',r=>cdnFails?r.abort():r.fulfill({contentType:'application/javascript',body:`window.session=${initialSession};window.member=${JSON.stringify(member)};`+mock}));
  const open=async f=>{await p.goto('about:blank');await p.goto('https://btcback.test/'+f+'.html');};
  const ready=()=>p.waitForFunction(()=>!document.querySelector('#member-status').textContent.includes('확인하고 있습니다.'));
  const login=async()=>{await p.fill('#email','test@example.com');await p.fill('#password','test-password');await p.click('#login-submit');};
  await open('login');await p.waitForSelector('#login-form');await login();await p.waitForFunction(()=>document.querySelector('#member-status').textContent.includes('승인 대기'));
  assert.deepEqual((await p.evaluate(()=>calls)).find(x=>x[0]==='profile'),['profile','profiles','member_status','id','u']);
  assert.equal(await p.inputValue('#password'),'');assert.equal(await p.evaluate(()=>options.auth.storageKey),'btcback-member-auth');assert(await p.evaluate(()=>options.auth.persistSession&&options.auth.autoRefreshToken&&!options.auth.detectSessionInUrl));
  await p.evaluate(()=>window.member='APPROVED');await p.click('#member-retry');await p.waitForURL('**/shopping.html');
  for(const state of ['PENDING','BLOCKED',null]){initialSession=true;member=state;await open('login');await ready();assert(await p.isHidden('#login-form'));assert((await p.innerText('#member-status')).includes(state==='PENDING'?'승인 대기':state==='BLOCKED'?'이용이 제한':'회원 정보를 확인할 수 없습니다'));}
  member='APPROVED';await open('login');await p.waitForURL('**/shopping.html');
  initialSession=false;await open('dashboard');await p.waitForURL('**/login.html');
  for(const state of ['PENDING','BLOCKED',null,'APPROVED']){initialSession=true;member=state;await open('dashboard');await ready();assert.equal(await p.isVisible('#member-dashboard'),state==='APPROVED');}
  assert.equal(await p.locator('.demo-badge').innerText(),'DEMO');assert((await p.innerText('.demo-notice')).includes('예시 데이터'));
  await p.evaluate(()=>{window.member='BLOCKED';document.dispatchEvent(new Event('visibilitychange'));});await ready();assert(await p.isHidden('#member-dashboard'));
  await p.evaluate(()=>window.logoutError=true);await p.click('#member-logout');await p.waitForFunction(()=>document.querySelector('#member-status').textContent.includes('로그아웃하지 못했습니다'));assert(await p.isHidden('#member-dashboard'));
  initialSession=false;await p.evaluate(()=>window.logoutError=false);await p.click('#member-logout');await p.waitForURL('**/login.html');await p.waitForSelector('#login-form');
  for(const error of [{code:'invalid_credentials'},{code:'email_not_confirmed'},{status:429}]){await open('login');await p.waitForSelector('#login-form');await p.evaluate(e=>window.loginError=e,error);await login();await p.waitForSelector('#member-status.error');assert(await p.isVisible('#login-form'));assert.equal(await p.inputValue('#password'),'');}
  for(const width of [320,390,768,1440]){await p.setViewportSize({width,height:900});await open('login');await p.waitForSelector('#login-form');assert(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));}
  initialSession=true;member='APPROVED';await open('dashboard');await ready();await p.evaluate(()=>{window.session=false;window.emit('SIGNED_OUT');});initialSession=false;await p.waitForURL('**/login.html');
  cdnFails=true;await open('dashboard');await p.waitForSelector('#member-status.error');assert(await p.isHidden('#member-dashboard'));
  const js=fs.readFileSync(path.join(root,'member-auth.js'),'utf8');assert(!/console\.|\.insert\(|\.update\(|localStorage\.setItem|sessionStorage\.setItem/.test(js));
  console.log('PASS login, UUID profile lookup, all statuses, existing sessions, logout/failure, status refresh, dashboard fail closed/DEMO, responsive and signup-independent storage');
 }finally{await b.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
