import { sign } from './sign.mjs';

const ENDPOINT = 'https://api-gateway.coupang.com/v2/providers/affiliate_open_api/apis/openapi/v1/deeplink';
export function validUrl(value, hosts) {
  if (typeof value !== 'string' || value.length > 4096) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && hosts.includes(url.hostname) && !url.username && !url.password && !url.port;
  } catch { return false; }
}

export function createHandler({ env, fetcher = fetch }) {
  return async req => {
    const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'content-type, apikey, authorization', 'Cache-Control': 'no-store' };
    const json = (body, status = 200) => Response.json(body, { status, headers });
    const fail = (error, status) => json({ success: false, error }, status);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (req.method !== 'POST') return fail('method_not_allowed', 405);
    let input;
    try {
      // Bound streamed request bodies, including requests without Content-Length.
      const reader = req.body?.getReader();
      if (!reader) return fail('invalid_request', 400);
      const chunks = [];
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 8192) { await reader.cancel(); return fail('request_too_large', 413); }
        chunks.push(value);
      }
      input = JSON.parse(await new Blob(chunks).text());
    } catch { return fail('invalid_request', 400); }
    if (!validUrl(input?.coupangUrl, ['www.coupang.com', 'coupang.com'])) return fail('invalid_coupang_url', 400);
    const access = env('COUPANG_ACCESS_KEY'), secret = env('COUPANG_SECRET_KEY');
    if (!access || !secret || !env('COUPANG_TRACKING_CODE')) return fail('configuration_missing', 503);
    try {
      const auth = await sign(access, secret);
      // trackingCode is deliberately not added: it is not in the documented body.
      const response = await fetcher(ENDPOINT, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: { Authorization: auth, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ coupangUrls: [input.coupangUrl], subId: 'btcback_test_001' }),
      });
      if (!response.ok) return fail('coupang_request_failed', 502);
      const payload = await response.json();
      if (String(payload?.rCode) !== '0' || !Array.isArray(payload.data) || payload.data.length !== 1) return fail('link_generation_failed', 502);
      const { shortenUrl, landingUrl } = payload.data[0] ?? {};
      if (!validUrl(shortenUrl, ['link.coupang.com', 'coupa.ng']) ||
          !validUrl(landingUrl, ['www.coupang.com', 'coupang.com'])) return fail('invalid_link_response', 502);
      const protectedValues = [access, secret, auth, auth.split('signature=')[1]];
      for (const value of [shortenUrl, landingUrl]) {
        const decoded = decodeURIComponent(value);
        if (protectedValues.some(key => decoded.includes(key)) || /authorization|signature|secret|access[_-]?key/i.test(decoded)) return fail('unsafe_link_response', 502);
      }
      return json({ success: true, shortenUrl, landingUrl });
    } catch { return fail('request_failed', 502); }
  };
}
