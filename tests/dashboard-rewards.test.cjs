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
 page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')logs.push(m.text());});
 await page.route('**/*',r=>{
 const url=new URL(r.request().url());
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
 const refresh=async rows=>{await page.evaluate(data=>{window.rows=data;window.emit();},rows);await page.waitForFunction(()=>document.querySelector('#member-dashboard').getAttribute('aria-busy')==='false'&&document.querySelector('[data-field="total_sats_earned"]').textContent!=='-');};
 for(const name of ['total_sats_earned','confirmed_sats','pending_sats'])assert.equal(await value(name),'0');
 assert.equal(await value('btc_amount'),'0.00000000');assert.match(await value('reward_history'),/아직 Reward 기록이 없습니다/);
 await refresh([row('1','CONFIRMED',100)]);
 assert.equal(await value('total_sats_earned'),'100');assert.equal(await value('btc_amount'),'0.00000100');assert.match(await value('reward_history'),/출석 Reward/);
 await refresh([row('1','CONFIRMED',100),row('2','PENDING',2150,{source_type:'SHOPPING',merchant:'COUPANG',created_at:'2026-09-15T00:00:00Z'}),row('3','CANCELLED',900),row('other','CONFIRMED',999999,{user_id:'member-b'})]);
 assert.equal(await value('total_sats_earned'),'100');assert.equal(await value('confirmed_sats'),'100');assert.equal(await value('pending_sats'),'2,150');
 assert.equal(await page.locator('.history-list li').count(),3);assert.match(await page.locator('.history-list li').first().innerText(),/Coupang/);
 assert.match(await page.locator('[data-status="CANCELLED"]').innerText(),/취소됨/);assert.equal(await page.locator('[data-status="CANCELLED"] strong').innerText(),'900 sats');
 assert.doesNotMatch(await value('reward_history'),/999,999/);
 const many=Array.from({length:505},(_,i)=>row(String(i).padStart(4,'0'),'CONFIRMED',100,{source_type:'SHOPPING',merchant:i===0?'<img src=x onerror=alert(1)>':i===1?'IHERB':'TRIPCOM'}));
 await refresh(many);assert.equal(await value('confirmed_sats'),'50,500');assert.equal(await page.locator('.history-list li').count(),505);assert.equal(await page.locator('.history-list img').count(),0);
 assert.match(await value('reward_history'),/iHerb/);assert.match(await value('reward_history'),/Trip.com/);
 for(const width of [320,390,768,1440]){
 await page.setViewportSize({width,height:900});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await page.screenshot({path:path.join(require('node:os').tmpdir(),`btcback-rewards-${width}.png`)});
 }
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
