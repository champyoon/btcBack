const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.join(__dirname,'..');
const mock = `
window.userId='member-a';window.rows=[];window.queries=[];window.fail=false;window.hold=false;window.foreign=false;
let callback=()=>{};
window.emit=()=>callback('TOKEN_REFRESHED');
window.supabase={createClient:()=>({auth:{
 getSession:async()=>({data:{session:userId?{user:{id:userId,email:'member@example.com'}}:null}}),
 getUser:async()=>({data:{user:{id:userId,email_confirmed_at:'2026-09-09'}}}),
 onAuthStateChange:cb=>callback=cb,
 signOut:async()=>{userId=null;callback('SIGNED_OUT');return {};}
},from:table=>{
 if(table==='profiles')return {select:()=>({eq:()=>({maybeSingle:async()=>({data:{member_status:'APPROVED'}})})})};
 if(table!=='rewards')throw Error('Unexpected table');
 let owner,columns,options,sort=[];
 const q={select:(c,o)=>{columns=c;options=o;return q;},eq:(key,id)=>{if(key!=='user_id')throw Error('Missing user filter');owner=id;return q;},order:(key,o)=>{sort.push([key,o]);return q;},range:async(start,end)=>{
 queries.push({owner,columns,options,sort,start,end});
 const data=rows.filter(r=>foreign||r.user_id===owner).sort((a,b)=>b.created_at.localeCompare(a.created_at)||b.id.localeCompare(a.id));
 const result=fail?{error:{code:'42501',message:'sensitive raw server text'}}:{data:data.slice(start,Math.min(end+1,start+100)),count:data.length,error:null};
 if(hold){hold=false;await new Promise(resolve=>window.release=resolve);}
 return result;
 }};return q;
}})};
`;
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH});
 try{
 const page=await browser.newPage(),errors=[],logs=[];
 let priceBody={success:true,market:'KRW-BTC',price:150000000},priceStatus=200,priceCalls=0,holdPrice=false,releasePrice;
 page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')logs.push(m.text());});
 await page.route('**/*',async r=>{
 const url=new URL(r.request().url());
 if(url.hostname==='pqlombgqscbacjkudirl.supabase.co'&&url.pathname==='/functions/v1/btc-krw-price'){
   priceCalls++;assert.equal(r.request().method(),'GET');assert.equal(url.search,'');
   const body=JSON.stringify(priceBody),status=priceStatus;
   if(holdPrice){holdPrice=false;await new Promise(resolve=>releasePrice=resolve);}
   return r.fulfill({status,body,contentType:'application/json',headers:{'Access-Control-Allow-Origin':'*'}}).catch(()=>{});
 }
 if(url.hostname==='cdn.jsdelivr.net')return r.fulfill({contentType:'application/javascript',body:mock});
 if(url.hostname!=='btcback.test')return r.abort();
 const file=url.pathname.slice(1);
 const body=file==='admin-config.js'?'const ADMIN_SUPABASE_URL="https://pqlombgqscbacjkudirl.supabase.co";const ADMIN_SUPABASE_KEY="sb_publishable_test";':fs.readFileSync(path.join(root,file),'utf8');
 return r.fulfill({body,contentType:file.endsWith('.js')?'application/javascript':file.endsWith('.css')?'text/css':'text/html'});
 });
 await page.goto('https://btcback.test/dashboard.html');
 const ready=()=>page.waitForFunction(()=>document.querySelector('#member-dashboard').getAttribute('aria-busy')==='false');
 await ready();
 const value=name=>page.locator(`[data-field="${name}"]`).innerText();
 const row=(id,status,amount,extra={})=>({id,user_id:'member-a',source_type:'ATTENDANCE',merchant:null,amount_sats:amount,status,created_at:'2026-09-14T00:00:00Z',...extra});
 const refresh=async rows=>{const before=await page.evaluate(()=>queries.length);await page.evaluate(data=>{window.rows=data;window.emit();},rows);await page.waitForFunction(n=>queries.length>n&&document.querySelector('#member-dashboard').getAttribute('aria-busy')==='false'&&document.querySelector('[data-field="total_sats_earned"]').textContent!=='-',before);};
 for(const name of ['total_sats_earned','confirmed_sats','pending_sats'])assert.equal(await value(name),'0');
 assert.equal(await value('btc_amount'),'0.00000000');assert.match(await value('reward_history'),/아직 Reward 기록이 없습니다/);
 assert.equal(await value('current_value_krw'),'현재 가치 · 약 ₩0');assert.equal(priceCalls,0);
 const noScroll=()=>page.locator('.history-list').evaluate(el=>el.scrollHeight<=el.clientHeight&&el.clientHeight<320);
 assert.ok(await noScroll());
 await refresh([row('1','CONFIRMED',100)]);
 assert.equal(await value('total_sats_earned'),'100');assert.equal(await value('btc_amount'),'0.00000100');assert.match(await value('reward_history'),/출석 Reward/);
 assert.ok(await noScroll());
 await refresh([row('1','CONFIRMED',100),row('2','PENDING',2150,{source_type:'SHOPPING',merchant:'COUPANG',created_at:'2026-09-15T00:00:00Z'}),row('3','CANCELLED',900),row('other','CONFIRMED',999999,{user_id:'member-b'})]);
 assert.equal(await value('total_sats_earned'),'100');assert.equal(await value('confirmed_sats'),'100');assert.equal(await value('pending_sats'),'2,150');
 assert.equal(await page.locator('.history-list li').count(),3);assert.match(await page.locator('.history-list li').first().innerText(),/Coupang/);
 assert.match(await page.locator('[data-status="CANCELLED"]').innerText(),/취소됨/);assert.equal(await page.locator('[data-status="CANCELLED"] strong').innerText(),'900 sats');
 assert.doesNotMatch(await value('reward_history'),/999,999/);
 const valueIs=text=>page.waitForFunction(s=>document.querySelector('[data-field="current_value_krw"]').textContent===s,text);
 await valueIs('현재 가치 · 약 ₩150');
 const pricingRows=[row('confirmed','CONFIRMED',1400),row('pending','PENDING',999999),row('cancelled','CANCELLED',999999)];
 holdPrice=true;await refresh(pricingRows);
 assert.equal(await value('total_sats_earned'),'1,400');assert.equal(await value('btc_amount'),'0.00001400');
 assert.equal(await value('current_value_krw'),'현재 가치 · 불러오는 중...');
 while(!releasePrice)await new Promise(resolve=>setTimeout(resolve,10));releasePrice();releasePrice=undefined;
 await valueIs('현재 가치 · 약 ₩2,100');
 for(const bad of [{success:true,market:'KRW-BTC',price:0},{success:true,market:'KRW-BTC',price:-1},{success:true,market:'KRW-BTC',price:'150000000'},{success:true,market:'KRW-ETH',price:100},{}]){
   priceBody=bad;await refresh(pricingRows);await valueIs('현재 가치를 불러올 수 없습니다.');
   assert.equal(await value('confirmed_sats'),'1,400');assert.equal(await value('pending_sats'),'999,999');
   assert.equal(await page.locator('.history-list li').count(),3);assert.equal(await page.locator('#rewards-message.error').count(),0);
 }
 priceStatus=502;await refresh(pricingRows);await valueIs('현재 가치를 불러올 수 없습니다.');assert.equal(await value('btc_amount'),'0.00001400');
 priceStatus=200;priceBody={success:true,market:'KRW-BTC',price:150000000};
 await refresh([row('round','CONFIRMED',1)]);await valueIs('현재 가치 · 약 ₩2');
 priceBody.price=149999999.5;await refresh([row('round','CONFIRMED',1)]);await valueIs('현재 가치 · 약 ₩1');
 priceBody.price=150000000;
 holdPrice=true;await refresh(pricingRows);while(!releasePrice)await new Promise(resolve=>setTimeout(resolve,10));
 await refresh([]);releasePrice();releasePrice=undefined;await valueIs('현재 가치 · 약 ₩0');
 const many=Array.from({length:505},(_,i)=>row(String(i).padStart(4,'0'),'CONFIRMED',100,{source_type:'SHOPPING',merchant:i===0?'<img src=x onerror=alert(1)>':i===1?'IHERB':'TRIPCOM'}));
 await refresh(many);assert.equal(await value('confirmed_sats'),'50,500');assert.equal(await page.locator('.history-list li').count(),505);assert.equal(await page.locator('.history-list img').count(),0);
 assert.match(await value('reward_history'),/iHerb/);assert.match(await value('reward_history'),/Trip.com/);
 await valueIs('현재 가치 · 약 ₩75,750');
 for(const width of [320,390,768,1440]){
 await page.setViewportSize({width,height:900});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 assert.ok(await page.evaluate(()=>{
   const box=s=>document.querySelector(s).getBoundingClientRect();
   const main=box('main'),earned=box('.earned'),status=box('.reward-status'),history=box('.reward-history');
   const confirmed=box('.status-item'),pending=box('.status-item.pending');
   const aligned=r=>Math.abs(r.left-main.left)<1&&Math.abs(r.right-main.right)<1;
   return aligned(earned)&&aligned(history)&&earned.bottom<=status.top&&status.bottom<=history.top&&
     (innerWidth<=700?confirmed.bottom<=pending.top:Math.abs(confirmed.top-pending.top)<1&&confirmed.right<pending.left);
 }),`layout order/width at ${width}`);
 assert.ok(await page.locator('.history-list').evaluate(el=>getComputedStyle(el).overflowY==='auto'&&el.clientHeight===320&&el.scrollHeight>el.clientHeight));
 const before=await page.evaluate(()=>({y:scrollY,height:document.documentElement.scrollHeight}));
 await page.locator('.history-list').evaluate(el=>el.scrollTop=200);
 assert.equal(await page.locator('.history-list').evaluate(el=>el.scrollTop),200);
 assert.deepEqual(await page.evaluate(()=>({y:scrollY,height:document.documentElement.scrollHeight})),before);
 await page.locator('.history-list').evaluate(el=>el.scrollTop=0);
 await page.screenshot({path:path.join(require('node:os').tmpdir(),`btcback-rewards-${width}.png`)});
 }
 await page.locator('.history-list').focus();await page.keyboard.press('ArrowDown');
 await page.waitForFunction(()=>document.querySelector('.history-list').scrollTop>0);
 await refresh([row('large','CONFIRMED','9007199254740993')]);assert.equal(await value('total_sats_earned'),'9,007,199,254,740,993');assert.equal(await value('btc_amount'),'90071992.54740993');
 await page.setViewportSize({width:320,height:900});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await page.evaluate(()=>{fail=true;emit();});await page.locator('#rewards-message.error').waitFor();
 assert.equal(await value('total_sats_earned'),'-');assert.equal(await page.locator('.history-list li').count(),0);assert.ok(!logs.join(' ').includes('sensitive raw'));
 await page.evaluate(()=>fail=false);await page.click('#rewards-retry');await ready();assert.equal(await value('confirmed_sats'),'9,007,199,254,740,993');
 await page.evaluate(()=>{foreign=true;rows=[{id:'other',user_id:'member-b',amount_sats:999999,status:'CONFIRMED',created_at:'2026-09-14'}];emit();});await page.locator('#rewards-message.error').waitFor();assert.equal(await page.locator('.history-list li').count(),0);
 await page.evaluate(()=>{foreign=false;rows=[];hold=true;emit();});await page.waitForFunction(()=>typeof release==='function');assert.equal(await value('confirmed_sats'),'-');
 await page.evaluate(()=>{userId='member-b';rows=[];emit();});await ready();await page.evaluate(()=>release());assert.equal(await value('confirmed_sats'),'0');
 const queries=await page.evaluate(()=>queries);assert.ok(queries.every(q=>q.owner&&q.options.count==='exact'&&q.sort[0][0]==='created_at'&&q.sort[0][1].ascending===false));
 await page.click('#member-logout');await page.waitForURL('**/login.html');
 assert.deepEqual(errors,[]);
 const source=fs.readFileSync(path.join(root,'dashboard-rewards.js'),'utf8');assert.doesNotMatch(source,/\.insert\(|\.update\(|\.delete\(/);
 console.log('PASS rewards: empty/confirmed/pending/cancelled, user isolation, paging, exact sats/BTC, safe HTML/errors, retry, session races and responsive');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
