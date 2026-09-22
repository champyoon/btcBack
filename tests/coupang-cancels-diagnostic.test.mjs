import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { authorization,parseArgs,run } from '../scripts/diagnose-coupang-cancels.mjs';
const env = {COUPANG_ACCESS_KEY:'fixture-access',COUPANG_SECRET_KEY:'fixture-secret'};
const args = ['20260921','20260921','channel1'];
test('cancels signs its exact GET path/query and validates inputs',async()=>{
  const q='startDate=20260921&endDate=20260921&subId=channel1&page=0';
  const auth=await authorization('key','secret',q,new Date('2026-09-22T00:00:00Z'));
  assert(auth.endsWith(createHmac('sha256','secret').update('260922T000000ZGET/v2/providers/affiliate_open_api/apis/openapi/v1/reports/cancels'+q).digest('hex')));
  assert.equal(parseArgs(args).page,'0');
  assert.throws(()=>parseArgs(['20260931','20260921','channel1']));
  assert.throws(()=>parseArgs([...args,'-1']));
});
test('cancels preserves signs, original date/IDs, uses only documented query and redacts secrets',async()=>{
  const result=await run(args,env,async(url,options)=>{
    const u=new URL(url);
    assert.equal(u.pathname,'/v2/providers/affiliate_open_api/apis/openapi/v1/reports/cancels');
    assert.deepEqual(Object.fromEntries(u.searchParams),{startDate:'20260921',endDate:'20260921',subId:'channel1',page:'0'});
    assert.equal(options.method,'GET');assert.equal(options.redirect,'error');
    return new Response('{"rCode":"0","rMessage":"fixture-secret","data":[{"orderDate":"20260918","date":"20260921","orderId":8914185084332805,"productId":13352471,"subId":"channel1","commission":390,"gmv":-13000,"productName":"fixture-access"}]}');
  });
  assert(result.success);assert.equal(result.cancels[0].orderId,'8914185084332805');
  assert.equal(result.cancels[0].commission,390);assert.equal(result.cancels[0].gmv,-13000);
  assert(!JSON.stringify(result).includes('fixture-secret'));assert(!JSON.stringify(result).includes('fixture-access'));
});
test('cancels reports pagination without automatic extra calls; fails safely',async()=>{
  let calls=0;
  const result=await run(args,env,async()=>{calls++;return Response.json({rCode:'0',data:Array.from({length:1000},()=>({commission:1}))});});
  assert.equal(calls,1);assert.equal(result.nextPage,1);
  assert.equal((await run(args,env,async()=>new Response('not JSON',{status:502}))).success,false);
  assert.equal((await run(args,env,async()=>Response.json({rCode:'400',data:[]}))).success,false);
});
