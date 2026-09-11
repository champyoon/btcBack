import { dateRange } from '../coupang-orders/handler.mjs';

const PATH = '/v2/providers/affiliate_open_api/apis/openapi/v1/reports/clicks';
// Observed on every row of the live 20260908..20260910 report (2026-09-10).
const FIELDS = ['date', 'trackingCode', 'subId', 'addtag', 'ctag', 'click'];
const IDENTIFIERS = ['trackingCode', 'subId', 'addtag', 'ctag'];

// Same Web Crypto algorithm as orders; that signer hardcodes the orders path.
export async function authorization(accessKey, secretKey, query, now = new Date()) {
  const signedDate = now.toISOString().replace(/[-:]/g, '').slice(2, 15) + 'Z';
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secretKey),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const bytes = await crypto.subtle.sign('HMAC', key, encoder.encode(signedDate + 'GET' + PATH + query));
  const signature = Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
  return `CEA algorithm=HmacSHA256, access-key=${accessKey}, signed-date=${signedDate}, signature=${signature}`;
}

export function createHandler({ env, fetcher = fetch, now = () => new Date() }) {
  const json = (body, status = 200) => Response.json(body, {
    status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  });
  const request = (url, options) => fetcher(url, {
    ...options, redirect: 'error', signal: AbortSignal.timeout(15000),
  });
  return async (req) => {
    if (req.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
    const bearer = req.headers.get('Authorization');
    if (!bearer || !/^Bearer \S+$/i.test(bearer)) return json({ error: 'authentication_required' }, 401);
    try {
      const base = env('SUPABASE_URL');
      const apiKey = env('SUPABASE_ANON_KEY');
      if (!base || !apiKey) return json({ error: 'server_configuration_missing' }, 503);
      // Verify Auth and membership under the caller's RLS, exactly as orders does.
      const headers = { apikey: apiKey, Authorization: bearer };
      const userResponse = await request(`${base}/auth/v1/user`, { headers });
      if (!userResponse.ok) return json({ error: 'invalid_session' }, 401);
      const user = await userResponse.json();
      if (!user?.id || typeof user.id !== 'string') return json({ error: 'invalid_session' }, 401);
      const memberQuery = new URLSearchParams({ select: 'user_id', user_id: `eq.${user.id}`, limit: '1' });
      const memberResponse = await request(`${base}/rest/v1/admin_users?${memberQuery}`, { headers });
      if (!memberResponse.ok) return json({ error: 'admin_check_failed' }, 503);
      const members = await memberResponse.json();
      if (!Array.isArray(members) || !members.some(row => row?.user_id === user.id)) return json({ error: 'admin_required' }, 403);

      const params = new URL(req.url).searchParams;
      const allowed = ['startDate', 'endDate', 'debug'];
      if ([...params.keys()].some(key => !allowed.includes(key) || params.getAll(key).length !== 1) ||
          (params.has('debug') && !['true', 'false'].includes(params.get('debug')))) {
        return json({ error: 'invalid_query' }, 400);
      }
      let range;
      try { range = dateRange(params, now()); }
      catch { return json({ error: 'invalid_dates', hint: 'Use YYYYMMDD, startDate <= endDate, no future dates, at most 30 days.' }, 400); }
      const accessKey = env('COUPANG_ACCESS_KEY');
      const secretKey = env('COUPANG_SECRET_KEY');
      const trackingCode = env('COUPANG_TRACKING_CODE');
      if (!accessKey || !secretKey || !trackingCode) return json({ error: 'coupang_secrets_missing' }, 503);
      const query = new URLSearchParams({ ...range, trackingCode }).toString();
      const auth = await authorization(accessKey, secretKey, query, now());
      const response = await request(`https://api-gateway.coupang.com${PATH}?${query}`, {
        headers: { Authorization: auth, Accept: 'application/json' },
      });
      if (!response.ok) return json({ error: 'coupang_http_error', upstreamStatus: response.status }, 502);
      let payload;
      try { payload = await response.json(); }
      catch { return json({ error: 'coupang_invalid_json' }, 502); }
      if (payload?.rCode !== '0' && payload?.rCode !== 0) return json({ error: 'coupang_report_error' }, 502);
      if (!Array.isArray(payload.data) || payload.data.some(row => !row || typeof row !== 'object' || Array.isArray(row))) {
        return json({ error: 'coupang_unexpected_schema' }, 502);
      }
      const protectedValues = [accessKey, secretKey, apiKey, bearer, bearer.split(/\s+/)[1], auth, auth.split('signature=')[1]];
      const safe = value => {
        if (value === null || typeof value === 'boolean') return value;
        if (typeof value !== 'string' && typeof value !== 'number') return '[omitted: non-scalar]';
        const text = String(value);
        if (protectedValues.some(secret => secret && text.includes(secret)) ||
            /\b(?:Bearer\s|CEA\s|authorization\s*[:=]|signature\s*[:=]|sb_secret_)/i.test(text)) return '[redacted]';
        return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 4000) : value;
      };
      const project = (row, fields) => Object.fromEntries(fields.filter(field => Object.hasOwn(row, field))
        .map(field => [field, safe(row[field])]));
      const clicks = payload.data.map(row => project(row, FIELDS));
      const result = { ...range, count: clicks.length, clicks };
      if (params.get('debug') === 'true') {
        result.debug = payload.data.map((row, index) => ({
          index, keys: Object.keys(row).map(safe), identifiers: project(row, IDENTIFIERS),
        }));
      }
      return json(result);
    } catch (error) {
      const timeout = error?.name === 'TimeoutError' || error?.name === 'AbortError';
      console.error('coupang-clicks', timeout ? 'timeout' : 'request_failed');
      return json({ error: timeout ? 'upstream_timeout' : 'request_failed' }, timeout ? 504 : 502);
    }
  };
}
