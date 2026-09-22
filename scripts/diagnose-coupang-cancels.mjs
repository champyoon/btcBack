import { pathToFileURL } from 'node:url';
import { dateRange } from '../supabase/functions/coupang-orders/handler.mjs';

const PATH = '/v2/providers/affiliate_open_api/apis/openapi/v1/reports/cancels';
const FIELDS = ['orderDate','date','trackingCode','subId','addtag','ctag','orderId','productId','productName','quantity','gmv','commissionRate','commission','categoryName'];

export function parseArgs(args) {
  const [startDate,endDate,subId,page = '0'] = args;
  if (args.length < 3 || args.length > 4 || !subId || !/^[A-Za-z0-9_-]{1,100}$/.test(subId) || !/^(0|[1-9]\d{0,5})$/.test(page)) throw Error('invalid_arguments');
  dateRange(new URLSearchParams({startDate,endDate}));
  return {startDate,endDate,subId,page};
}

// Same verified orders signing format, with the cancellation report path.
export async function authorization(access,secret,query,now = new Date()) {
  const date = now.toISOString().replace(/[-:]/g,'').slice(2,15)+'Z';
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw',encoder.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const bytes = await crypto.subtle.sign('HMAC',key,encoder.encode(date+'GET'+PATH+query));
  const signature = Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');
  return `CEA algorithm=HmacSHA256, access-key=${access}, signed-date=${date}, signature=${signature}`;
}

export async function run(args,env = process.env,fetcher = fetch) {
  const params = parseArgs(args);
  const access = env.COUPANG_ACCESS_KEY, secret = env.COUPANG_SECRET_KEY;
  if (!access || !secret) throw Error('missing_configuration');
  const query = new URLSearchParams(params).toString();
  const auth = await authorization(access,secret,query);
  const response = await fetcher('https://api-gateway.coupang.com'+PATH+'?'+query,{
    method:'GET',headers:{Authorization:auth,Accept:'application/json'},redirect:'error',signal:AbortSignal.timeout(20000),
  });
  const protectedValues = [access,secret,auth,auth.split('signature=')[1]];
  const safe = value => {
    if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
    if (typeof value !== 'string') return '[omitted]';
    let text = value;
    for (const item of protectedValues) text = text.split(item).join('[redacted]');
    return text.replace(/(?:Bearer\s|CEA\s|Authorization\s*[:=]|signature\s*[:=]).*/gi,'[redacted]').replace(/[\u0000-\u001f\u007f]/g,' ').slice(0,4000);
  };
  let payload;
  try {
    payload = JSON.parse(await response.text(),(key,value,context)=>{
      if (['orderId','productId'].includes(key) && typeof value === 'number') {
        if (!Number.isSafeInteger(value) && !context?.source) throw Error('unsafe_id');
        return context?.source ?? String(value);
      }
      return value;
    });
  } catch { return {httpStatus:response.status,success:false,error:'invalid_json_or_unsafe_id'}; }
  const success = response.ok && String(payload?.rCode) === '0' && Array.isArray(payload?.data);
  return {httpStatus:response.status,success,rCode:safe(payload?.rCode),rMessage:safe(payload?.rMessage),...params,
    count:success ? payload.data.length : 0,
    nextPage:success && payload.data.length === 1000 ? Number(params.page)+1 : null,
    cancels:success ? payload.data.map(row=>Object.fromEntries(FIELDS.filter(key=>Object.hasOwn(row,key)).map(key=>[key,safe(row[key])]))) : []};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await run(process.argv.slice(2));
    console.log(JSON.stringify(result,null,2));
    if (!result.success) process.exitCode = 1;
  } catch {
    console.log(JSON.stringify({success:false,error:'request_failed_check_arguments_configuration_or_network'}));
    process.exitCode = 1;
  }
}
