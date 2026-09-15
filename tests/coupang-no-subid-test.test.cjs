const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const read = file => fs.readFileSync(path.join(__dirname,'..',file),'utf8');
const source = read('coupang-no-subid-test.js');
assert(!/window\.open|landingUrl|profiles|coupang_sub_id/.test(source));
assert(source.includes('window.location.assign(data.shortenUrl)'));
(async()=>{
  const browser=await chromium.launch({executablePath:process.env.CHROME_PATH,headless:true});
  try {
    const page=await browser.newPage();
    await page.addInitScript(()=>{window.BTCBackMember={getSession:async()=>({data:{session:{access_token:'fixture-session-token'}}})};});
    const endpoint='https://pqlombgqscbacjkudirl.supabase.co/functions/v1/coupang-deeplink-no-subid';
    const short='https://link.coupang.com/a/mock';
    let output=short, failure=false, calls=0, navigations=0, release, delayed=false;
    let errorCase;
    await page.route('**/*',async route=>{
      const url=new URL(route.request().url());
      if(url.href===endpoint){
        calls++;
        assert.equal(route.request().method(),'POST');
        assert.equal(route.request().headers().authorization,'Bearer fixture-session-token');
        assert.deepEqual(route.request().postDataJSON(),{coupangUrl:'https://www.coupang.com/'});
        if(errorCase) return route.fulfill({status:errorCase.status,contentType:'application/json',headers:{'Access-Control-Allow-Origin':'*'},body:JSON.stringify({success:false,error:errorCase.error})});
        if(delayed) await new Promise(resolve=>{release=resolve;});
        return route.fulfill({status:failure?502:200,contentType:'application/json',headers:{'Access-Control-Allow-Origin':'*'},body:JSON.stringify({success:!failure,shortenUrl:output,landingUrl:'https://link.coupang.com/re/AFFHOME?subid=channel1'})});
      }
      if(url.href===short){navigations++;return route.fulfill({contentType:'text/html',body:'Mock destination'});}
      if(url.hostname==='btcback.test'&&['/shopping.html','/common.css','/coupang-no-subid-test.js'].includes(url.pathname)) return route.fulfill({contentType:url.pathname.endsWith('.js')?'text/javascript':url.pathname.endsWith('.css')?'text/css':'text/html',body:read(url.pathname.slice(1))});
      return route.abort();
    });
    await page.goto('https://btcback.test/shopping.html');
    const button=page.locator('#coupang-no-subid-prepare');
    await page.evaluate(()=>{window.BTCBackMember.getSession=async()=>({data:{session:null}});});
    await button.click();
    await page.waitForFunction(()=>!document.getElementById('coupang-no-subid-prepare').disabled);
    assert.equal(calls,0);assert.equal(navigations,0);
    await page.evaluate(()=>{window.BTCBackMember.getSession=async()=>({data:{session:{access_token:'fixture-session-token'}}});});
    assert.equal(await page.locator('#panel-coupang .partner-cta:visible').count(),1);
    assert.equal(await page.locator('#coupang-no-subid-link').count(),0);
    assert(!/TEST|channel1|channel2|테스트/.test(await page.locator('#panel-coupang').innerText()));
    for(const width of [320,390,768,1440]){
      await page.setViewportSize({width,height:900});
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
      const box=await button.boundingBox();assert(box.x>=0&&box.x+box.width<=width&&box.height>=44);
    }
    for(const invalid of [undefined,'','http://link.coupang.com/a/test','https://evil.test','https://link.coupang.com.evil.test','https://user:pass@link.coupang.com/a/test','https://link.coupang.com:444/a/test']){
      output=invalid;await button.click();
      await page.waitForFunction(()=>!document.getElementById('coupang-no-subid-prepare').disabled);
      assert.equal(navigations,0);assert.equal(page.url(),'https://btcback.test/shopping.html');
      assert((await page.locator('#coupang-no-subid-status').innerText()).includes('연결하지 못했습니다'));
    }
    for (const sample of [
      {status:403,error:'coupang_access_unassigned'},
      {status:403,error:'coupang_access_unavailable'},
      {status:401,error:'authentication_required'},
      {status:502,error:'coupang_request_failed'},
      {status:503,error:'coupang_access_unassigned'}
    ]) {
      errorCase=sample;await button.click();
      await page.waitForFunction(()=>!document.getElementById('coupang-no-subid-prepare').disabled);
      assert.equal(await page.locator('#coupang-no-subid-status').innerText(),sample.status===403&&sample.error==='coupang_access_unassigned'?'현재 이 계정에서는 쿠팡 리워드를 이용할 수 없습니다.':'쿠팡에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.');
      assert.equal(navigations,0);
    }
    errorCase=null;
    output=short;failure=true;await button.click();
    await page.waitForFunction(()=>!document.getElementById('coupang-no-subid-prepare').disabled);
    assert.equal(navigations,0);
    failure=false;delayed=true;const before=calls;
    await button.evaluate(b=>{b.click();b.click();});
    await page.waitForFunction(()=>document.getElementById('coupang-no-subid-prepare').disabled);
    while(!release) await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(calls,before+1);release();await page.waitForURL(short);
    assert.equal(navigations,1);assert.equal(calls,before+1);
    console.log('PASS C one-click: unchanged request, single navigation, duplicates, missing/unsafe URL denial, retry and responsive');
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
