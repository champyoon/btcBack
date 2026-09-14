const assert=require('node:assert/strict'),fs=require('node:fs');
const {chromium}=require('playwright');
(async()=>{
 const html=fs.readFileSync('reward.html','utf8');
 assert.doesNotMatch(html,/<form\b|<script\b|reward_requests|\.insert\(/i);
 assert.match(html,/Reward 신청 방식이 변경되었습니다/);
 const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH});
 try{
 const page=await browser.newPage();
 await page.route('**/*',r=>r.fulfill({body:html,contentType:'text/html'}));
 await page.goto('https://btcback.test/reward.html');
 for(const width of [320,390,768,1440]){
 await page.setViewportSize({width,height:900});
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 }
 console.log('PASS retired request URL and responsive notice');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
