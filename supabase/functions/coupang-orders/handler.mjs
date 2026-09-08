const PATH = '/v2/providers/affiliate_open_api/apis/openapi/v1/reports/orders';
const FIELDS = ['date', 'trackingCode', 'subId', 'orderId', 'productId',
  'productName', 'quantity', 'gmv', 'commissionRate', 'commission', 'categoryName'];
const DAY = 86400000;
const DEBUG_FIELDS = ['orderNumber', 'orderId', 'subId', 'subParam', 'addtag',
  'ctag', 'pageId', 'trackingCode', 'productId', 'vendorItemId',
  'originalOrderId', 'transactionId', 'purchaseId'];

export function dateRange(params, now = new Date()) {
  const today = new Date(now.getTime() + 9 * 3600000).toISOString().slice(0, 10).replaceAll('-', '');
  const parse = (value) => {
    if (!/^\d{8}$/.test(value)) throw new Error('date');
    const date = new Date(`${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6)}T00:00:00Z`);
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10).replaceAll('-', '') !== value) throw new Error('date');
    return date.getTime();
  };
  const endDate = params.get('endDate') ?? today;
  const end = parse(endDate);
  const startDate = params.get('startDate') ?? new Date(end - 6 * DAY).toISOString().slice(0, 10).replaceAll('-', '');
  const start = parse(startDate);
  // Bound this diagnostic endpoint to at most 30 calendar days per call.
  if (start > end || end - start > 29 * DAY || endDate > today || startDate < '20181101') throw new Error('range');
  return { startDate, endDate };
}

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
    const base = env('SUPABASE_URL');
    const apiKey = env('SUPABASE_ANON_KEY');
    if (!base || !apiKey) return json({ error: 'server_configuration_missing' }, 503);
    try {
      // Verify the user with Auth, then query membership under that user's RLS.
      // A public API key alone is never sufficient; no service_role is used.
      const headers = { apikey: apiKey, Authorization: bearer };
      const userResponse = await request(`${base}/auth/v1/user`, { headers });
      if (!userResponse.ok) return json({ error: 'invalid_session' }, 401);
      const user = await userResponse.json();
      if (!user.id) return json({ error: 'invalid_session' }, 401);
      const memberQuery = new URLSearchParams({ select: 'user_id', user_id: `eq.${user.id}`, limit: '1' });
      const memberResponse = await request(`${base}/rest/v1/admin_users?${memberQuery}`, { headers });
      if (!memberResponse.ok) return json({ error: 'admin_check_failed' }, 503);
      const members = await memberResponse.json();
      if (!Array.isArray(members) || !members.some(row => row.user_id === user.id)) return json({ error: 'admin_required' }, 403);

      let range;
      try { range = dateRange(new URL(req.url).searchParams, now()); }
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
      // Never echo upstream error bodies, credentials, signatures or request headers.
      if (!response.ok) return json({ error: 'coupang_http_error', upstreamStatus: response.status }, 502);
      let payload;
      try { payload = await response.json(); }
      catch { return json({ error: 'coupang_invalid_json' }, 502); }
      if (payload?.rCode !== '0' && payload?.rCode !== 0) return json({ error: 'coupang_report_error' }, 502);
      if (!Array.isArray(payload.data)) return json({ error: 'coupang_unexpected_schema' }, 502);
      const orders = payload.data.map(row => Object.fromEntries(FIELDS.map(field => [field, row[field] ?? null])));
      const result = { ...range, count: orders.length, orders };
      if (new URL(req.url).searchParams.get('debug') === 'true') {
        // Values are allowlisted scalars only; never return raw objects/headers.
        const protectedValues = [accessKey, secretKey, auth, bearer, auth.split('signature=')[1]];
        const safeValue = value => {
          if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
          if (typeof value !== 'string') return '[omitted: non-scalar]';
          if (protectedValues.some(secret => secret && value.includes(secret)) || /\b(?:Bearer\s|CEA\s|signature=)/i.test(value)) return '[redacted]';
          return value;
        };
        result.debug = payload.data.map((row, index) => ({
          index,
          keys: Object.keys(row).map(safeValue),
          identifiers: Object.fromEntries(DEBUG_FIELDS.filter(field => Object.hasOwn(row, field))
            .map(field => [field, safeValue(row[field])])),
        }));
      }
      return json(result);
    } catch (error) {
      const timeout = error?.name === 'TimeoutError' || error?.name === 'AbortError';
      console.error('coupang-orders', timeout ? 'timeout' : 'request_failed');
      return json({ error: timeout ? 'upstream_timeout' : 'request_failed' }, timeout ? 504 : 502);
    }
  };
}
