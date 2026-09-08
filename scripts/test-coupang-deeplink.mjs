import { pathToFileURL } from 'node:url';

const PATH = '/v2/providers/affiliate_open_api/apis/openapi/v1/deeplink';
export function parseArgs(args) {
  const flags = args.filter(arg => arg.startsWith('--'));
  const urls = args.filter(arg => !arg.startsWith('--'));
  if (urls.length !== 1 || flags.length > 1 || flags.some(flag => !['--with-subid', '--without-subid'].includes(flag))) throw new Error('invalid_arguments');
  const url = new URL(urls[0]);
  if (url.protocol !== 'https:' || url.hostname !== 'www.coupang.com' || url.username || url.password || url.port) throw new Error('invalid_url');
  return { url: urls[0], withSubId: flags[0] !== '--without-subid' };
}

// Same Web Crypto signing algorithm as coupang-orders, with POST and its own path.
// The existing orders helper hardcodes GET and the orders path, so cannot be called here.
export async function sign(accessKey, secretKey, now = new Date()) {
  const signedDate = now.toISOString().replace(/[-:]/g, '').slice(2, 15) + 'Z';
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secretKey),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const bytes = await crypto.subtle.sign('HMAC', key, encoder.encode(signedDate + 'POST' + PATH));
  const signature = Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
  return `CEA algorithm=HmacSHA256, access-key=${accessKey}, signed-date=${signedDate}, signature=${signature}`;
}

export async function run(options, env = process.env, fetcher = fetch) {
  const validated = parseArgs([options.url, options.withSubId === false ? '--without-subid' : '--with-subid']);
  const body = { coupangUrls: [validated.url] };
  if (validated.withSubId) body.subId = 'btcback_test_001';
  const accessKey = env.COUPANG_ACCESS_KEY;
  const secretKey = env.COUPANG_SECRET_KEY;
  const trackingCode = env.COUPANG_TRACKING_CODE;
  if (!accessKey || !secretKey || !trackingCode) throw new Error('missing_configuration');
  // trackingCode is checked locally only: the supplied API schema has no such field.
  const authorization = await sign(accessKey, secretKey);
  const response = await fetcher('https://api-gateway.coupang.com' + PATH, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
    headers: { Authorization: authorization, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  const protectedValues = [accessKey, secretKey, authorization, authorization.split('signature=')[1]];
  const safe = value => {
    if (typeof value !== 'string' && typeof value !== 'number' && value !== null) return '[omitted]';
    let text = String(value);
    for (const secret of protectedValues) text = text.split(secret).join('[redacted]');
    text = text.replace(/(?:CEA\s+|Bearer\s+|Authorization\s*[:=]|signature\s*[:=]).*/gi, '[redacted]');
    text = text.replace(/[\u0000-\u001f\u007f]/g, ' ');
    return typeof value === 'string' ? text.slice(0, 4000) : value;
  };
  const result = { httpStatus: response.status, rCode: null, rMessage: null,
    originalUrl: null, shortenUrl: null, landingUrl: null };
  let raw;
  try { raw = await response.json(); }
  catch { return result; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return result;
  }
  for (const field of ['rCode', 'rMessage']) if (Object.hasOwn(raw, field)) result[field] = safe(raw[field]);
  const row = Array.isArray(raw.data) ? raw.data[0] : null;
  if (row && typeof row === 'object') {
    for (const field of ['originalUrl', 'shortenUrl', 'landingUrl']) if (Object.hasOwn(row, field)) result[field] = safe(row[field]);
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await run(parseArgs(process.argv.slice(2))), null, 2)); }
  catch { console.error('Test failed. Usage: node --env-file=.env.coupang scripts/test-coupang-deeplink.mjs "https://www.coupang.com/vp/products/..." [--with-subid|--without-subid]. Check URL, environment and network.'); process.exitCode = 1; }
}
