const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.join(__dirname, '..');
const mock = `
window.user = null; window.authCallback = () => {}; window.failUpdate = false; window.conflict = false;
window.updates = 0; window.privateReads = 0; window.lastUpdate = null;
window.records = Array.from({length: 27}, (_,i) => ({
  id: String(i), created_at: new Date(Date.UTC(2026,0,28-i)).toISOString(),
  store_name: '쿠팡', purchase_date: '2026-01-01', purchase_amount: 52000,
  order_number: 'ORDER-'+i, customer_name: 'Customer '+i, email: 'customer@example.com',
  lightning_destination: 'test@wallet.com', memo: '<img src=x onerror=alert(1)>',
  reward_sats: i===2||i===3 ? 350 : null,
  reward_confirmed_at: i===2||i===3 ? '2026-01-02T00:00:00Z' : null,
  paid_at: i===3 ? '2026-01-03T00:00:00Z' : null,
  status: ['pending','purchase_confirmed','reward_confirmed','paid','rejected'][i] || 'pending'
}));
function query(table) {
  const filters = []; let options={}, range=null, update=null, single=false;
  const q = {
    select: (columns, opts={}) => { options=opts; return q; },
    eq: (key,value) => { filters.push([key,value]); return q; },
    order: () => q, range: (from,to) => { range=[from,to]; return q; },
    update: value => { update=value; return q; },
    maybeSingle: () => { single=true; return q; },
    then: (resolve,reject) => Promise.resolve().then(() => {
      if(table==='admin_users') return {data: user?.id==='admin' ? {user_id:'admin'} : null, error:null};
      if(user?.id!=='admin') throw new Error('Unauthorized private query');
      window.privateReads++;
      let data=records.filter(row => filters.every(([key,value]) => row[key]===value));
      if(update) {
        window.updates++;
        window.lastUpdate = update;
        if(failUpdate) return {data:null,error:{code:'42501'}};
        if(conflict) return {data:[],error:null};
        data.forEach(row=>{
          Object.assign(row,update);
          if(update.status==='reward_confirmed') row.reward_confirmed_at='2026-01-04T00:00:00Z';
          if(update.status==='paid') row.paid_at='2026-01-05T00:00:00Z';
        });
      }
      const count=data.length;
      if(range) data=data.slice(range[0],range[1]+1);
      return {data:options.head?null:JSON.parse(JSON.stringify(data)), count, error:null};
    }).then(resolve,reject)
  }; return q;
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
    await login(); await page.waitForFunction(()=>document.querySelectorAll('#requests tr').length===25);
    assert.equal(await page.locator('#count-all').textContent(),'27');
    assert.equal(await page.locator('#count-pending').textContent(),'23');
    await page.click('#next'); await page.waitForFunction(()=>document.querySelectorAll('#requests tr').length===2);
    await page.click('#previous'); await page.waitForFunction(()=>document.querySelectorAll('#requests tr').length===25);
    await page.locator('#requests tr').first().getByRole('button',{name:'상세',exact:true}).click();
    assert.ok((await page.locator('#detail-fields').textContent()).includes('ORDER-0'));
    assert.equal(await page.locator('#detail img').count(),0);
    await page.click('#close-detail');
    page.once('dialog',dialog=>dialog.dismiss());
    await page.locator('[data-update="purchase_confirmed"]').first().click();
    assert.equal(await page.evaluate(()=>updates),0);
    page.once('dialog',dialog=>dialog.accept());
    await page.locator('[data-update="purchase_confirmed"]').first().click();
    await page.waitForFunction(()=>document.getElementById('dashboard-message').textContent==='상태를 변경했습니다.');
    assert.equal(await page.evaluate(()=>records[0].status),'purchase_confirmed');
    const sats = page.locator('[data-reward-sats="0"]');
    for (const invalid of ['', '0', '-1', '1.5', '1e3']) {
      await sats.fill(invalid);
      await page.locator('#requests tr').first().locator('[data-update="reward_confirmed"]').click();
      assert.equal(await page.evaluate(()=>updates),1);
    }
    await sats.fill('350');
    page.once('dialog',dialog=>dialog.dismiss());
    await page.locator('#requests tr').first().locator('[data-update="reward_confirmed"]').click();
    assert.equal(await page.evaluate(()=>updates),1);
    page.once('dialog',dialog=>dialog.accept());
    await page.locator('#requests tr').first().locator('[data-update="reward_confirmed"]').click();
    await page.waitForFunction(()=>!document.querySelector('[data-update]').disabled);
    assert.deepEqual(await page.evaluate(()=>lastUpdate),{status:'reward_confirmed',reward_sats:350});
    assert.equal(await page.evaluate(()=>updates),2);
    assert.equal(await sats.count(),0);
    assert.ok((await page.locator('#requests tr').first().textContent()).includes('350 sats'));
    await page.locator('#requests tr').first().getByRole('button',{name:'상세',exact:true}).click();
    assert.ok((await page.locator('#detail-fields').textContent()).includes('확정 시각'));
    await page.click('#close-detail');
    let paidWarning=''; page.once('dialog',dialog=>{paidWarning=dialog.message();dialog.accept();});
    await page.locator('[data-update="paid"]').first().click();
    await page.waitForFunction(()=>window.records[0].status==='paid');
    assert.ok(paidWarning.includes('실제로 Bitcoin Lightning 지급을 완료했는지 확인하세요'));
    assert.ok((await page.locator('#requests tr').first().textContent()).includes('지급 시각'));
    await page.selectOption('#status-filter','rejected');
    await page.waitForFunction(()=>document.querySelectorAll('#requests tr').length===1);
    assert.equal(await page.locator('#count-all').textContent(),'27');
    await page.selectOption('#status-filter','');
    await page.waitForFunction(()=>document.querySelectorAll('#requests tr').length===25);
    await page.evaluate(()=>{window.failUpdate=true;});
    page.once('dialog',dialog=>dialog.accept());
    await page.locator('[data-update="rejected"]').first().click();
    await page.waitForFunction(()=>document.getElementById('dashboard-message').classList.contains('error'));
    assert.equal(await page.evaluate(()=>records[0].status),'paid');
    await page.evaluate(()=>{window.failUpdate=false;window.conflict=true;});
    page.once('dialog',dialog=>dialog.accept());
    await page.locator('[data-update="rejected"]').first().click();
    await page.waitForFunction(()=>!document.querySelector('[data-update]').disabled);
    assert.equal(await page.evaluate(()=>records[0].status),'paid');
    for(const width of [1920,768,390,320]) {
      await page.setViewportSize({width,height:1080});
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
      assert.equal(await page.locator('.sats-field > span').first().evaluate(node=>node.getBoundingClientRect().height<=parseFloat(getComputedStyle(node).lineHeight)+1),true);
      if(width===390) await page.locator('.reward-label').first().scrollIntoViewIfNeeded();
      if(width===1920||width===390) await page.screenshot({path:path.join(os.tmpdir(),'btcback-admin-'+width+'.png'),fullPage:false});
    }
    await page.locator('#requests tr').first().getByRole('button',{name:'상세',exact:true}).click();
    await page.keyboard.press('Escape'); await page.click('#logout');
    assert.equal(await page.locator('#dashboard').isVisible(),false);
    assert.equal(await page.locator('#requests tr').count(),0);
    assert.equal(await page.locator('#detail-fields').textContent(),'');
    assert.deepEqual(errors,[]);
    console.log('PASS login/non-admin denial, counts, pagination, filters, safe details, confirmations, updates, failure/conflict, logout and responsive UI');
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
