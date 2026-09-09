import { sign } from './sign.mjs';

const ENDPOINT = 'https://api-gateway.coupang.com/v2/providers/affiliate_open_api/apis/openapi/v1/deeplink';
export function validUrl(value, hosts) {
  if (typeof value !== 'string' || value.length > 4096) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && hosts.includes(url.hostname) && !url.username && !url.password && !url.port;
  } catch { return false; }
}

export function timestampSubId(date = new Date()) {
  return new Date(date.getTime() + 9 * 60 * 60 * 1000).toISOString()
    .slice(2, 19).replace(/[-T:]/g, '');
}

export function createHandler({ env, fetcher = fetch, logger = console, now = () => new Date() }) {
  return async req => {
    let stage = 'request-parse';
    let upstreamStatus;
    let payload;
    // Log only known-safe diagnostics, never arbitrary exception/upstream text.
    const diagnostic = (error) => {
      const names = ['Error', 'TypeError', 'SyntaxError', 'URIError', 'TimeoutError', 'AbortError'];
      const messages = ['url convert failed', 'success', 'Success'];
      const entry = { stage };
      if (error) {
        entry.errorName = names.includes(error.name) ? error.name : 'Error';
        entry.errorMessage = 'Operation failed; raw exception message omitted for credential safety';
      }
      if (upstreamStatus !== undefined) entry.httpStatus = upstreamStatus;
      if (payload && Object.hasOwn(payload, 'rCode')) {
        const code = String(payload.rCode);
        entry.rCode = /^\d{1,6}$/.test(code) ? code : '[omitted]';
      }
      if (payload && Object.hasOwn(payload, 'rMessage')) entry.rMessage = messages.includes(payload.rMessage) ? payload.rMessage : '[omitted: untrusted upstream text]';
      try { logger.error('[coupang-deeplink]', entry); } catch { /* Logging must not mask the response. */ }
    };
    const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'content-type, apikey, authorization', 'Cache-Control': 'no-store' };
    const json = (body, status = 200) => Response.json(body, { status, headers });
    const fail = (error, status) => { diagnostic(); return json({ success: false, error, stage }, status); };
    try {
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
    } catch (error) { diagnostic(error); return fail('invalid_request', 400); }
    stage = 'input-validation';
    if (!validUrl(input?.coupangUrl, ['www.coupang.com', 'coupang.com'])) return fail('invalid_coupang_url', 400);
    stage = 'configuration';
    const access = env('COUPANG_ACCESS_KEY'), secret = env('COUPANG_SECRET_KEY');
    if (!access || !secret || !env('COUPANG_TRACKING_CODE')) return fail('configuration_missing', 503);
    try {
      stage = 'sign';
      const auth = await sign(access, secret);
      // trackingCode is deliberately not added: it is not in the documented body.
      stage = 'coupang-fetch';
      const response = await fetcher(ENDPOINT, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: { Authorization: auth, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ coupangUrls: [input.coupangUrl], subId: timestampSubId(now()) }),
      });
      upstreamStatus = response.status;
      stage = 'response-parse';
      try { payload = await response.json(); }
      catch (error) { diagnostic(error); return fail(response.ok ? 'invalid_response_json' : 'coupang_request_failed', 502); }
      stage = 'coupang-status';
      if (!response.ok) return fail('coupang_request_failed', 502);
      stage = 'response-schema';
      if (String(payload?.rCode) !== '0' || !Array.isArray(payload.data) || payload.data.length !== 1) return fail('link_generation_failed', 502);
      const { shortenUrl, landingUrl } = payload.data[0] ?? {};
      stage = 'shorten-url-validation';
      if (!validUrl(shortenUrl, ['link.coupang.com', 'coupa.ng'])) return fail('invalid_link_response', 502);
      stage = 'landing-url-validation';
      if (!validUrl(landingUrl, ['www.coupang.com', 'coupang.com', 'link.coupang.com'])) return fail('invalid_link_response', 502);
      // Official affiliate landing links use this path, not the storefront host.
      const landing = new URL(landingUrl);
      if (landing.hostname === 'link.coupang.com' && !['/re/AFFSDP', '/re/AFFHOME'].includes(landing.pathname)) return fail('invalid_link_response', 502);
      stage = 'credential-leak-check';
      const protectedValues = [access, secret, auth, auth.split('signature=')[1]];
      for (const value of [shortenUrl, landingUrl]) {
        const decoded = decodeURIComponent(value);
        if (protectedValues.some(key => decoded.includes(key)) || /authorization|signature|secret|access[_-]?key/i.test(decoded)) return fail('unsafe_link_response', 502);
      }
      return json({ success: true, shortenUrl, landingUrl });
    } catch (error) { diagnostic(error); return json({ success: false, error: 'request_failed', stage }, 502); }
    } catch (error) { diagnostic(error); return json({ success: false, error: 'internal_error', stage }, 500); }
  };
}
