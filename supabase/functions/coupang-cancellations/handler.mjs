import { dateRange } from '../coupang-orders/handler.mjs';

const PATH = '/v2/providers/affiliate_open_api/apis/openapi/v1/reports/cancels';
const PAGE_SIZE = 1000;
const MAX_PAGES = 100;

// Same UTC datetime + GET + path + query HMAC format as orders.
export async function authorization(access, secret, query, now) {
  const date = now.toISOString().replace(/[-:]/g, '').slice(2, 15) + 'Z';
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const bytes = await crypto.subtle.sign('HMAC', key, encoder.encode(date + 'GET' + PATH + query));
  const signature = Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
  return `CEA algorithm=HmacSHA256, access-key=${access}, signed-date=${date}, signature=${signature}`;
}

export function createHandler({ env, fetcher = fetch, now = () => new Date(), internalAdminId }) {
  const json = (body, status = 200) => Response.json(body, {
    status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  });
  return async req => {
    const fail = (error, status, extra = {}) => json({ success: false, error, ...extra }, status);
    if (req.method !== 'GET') return fail('method_not_allowed', 405);
    const bearer = req.headers.get('Authorization');
    if (!bearer || !/^Bearer \S+$/i.test(bearer)) return fail('authentication_required', 401);
    const base = env('SUPABASE_URL'), apiKey = env(internalAdminId ? 'SUPABASE_SERVICE_ROLE_KEY' : 'SUPABASE_ANON_KEY');
    if (!base || !apiKey) return fail('server_configuration_missing', 503);
    const deadline = AbortSignal.timeout(90000);
    const request = (url, options) => fetcher(url, { ...options, method: 'GET', redirect: 'error',
      signal: AbortSignal.any([deadline, AbortSignal.timeout(15000)]) });
    try {
      // Internal factory option only; public HTTP callers still require a verified user JWT.
      const headers = { apikey: apiKey, Authorization: internalAdminId ? `Bearer ${apiKey}` : bearer };
      let user = { id: internalAdminId };
      if (!internalAdminId) {
        const authResponse = await request(`${base}/auth/v1/user`, { headers });
        if (!authResponse.ok) return fail('invalid_session', 401);
        user = await authResponse.json();
      }
      if (!user?.id) return fail('invalid_session', 401);
      const memberQuery = new URLSearchParams({ select: 'user_id', user_id: `eq.${user.id}`, limit: '1' });
      const memberResponse = await request(`${base}/rest/v1/admin_users?${memberQuery}`, { headers });
      if (!memberResponse.ok) return fail('admin_check_failed', 503);
      const members = await memberResponse.json();
      if (!Array.isArray(members) || !members.some(row => row.user_id === user.id)) return fail('admin_required', 403);
      const params = new URL(req.url).searchParams;
      if ([...params.keys()].some(key => !['startDate', 'endDate', 'subId', 'debug'].includes(key) || params.getAll(key).length !== 1)
        || (params.has('debug') && !['true', 'false'].includes(params.get('debug')))
        || (params.has('subId') && !/^[A-Za-z0-9_-]{1,100}$/.test(params.get('subId')))) return fail('invalid_parameters', 400);
      let range;
      try { range = dateRange(params, now()); }
      catch { return fail('invalid_dates', 400); }
      const access = env('COUPANG_ACCESS_KEY'), secret = env('COUPANG_SECRET_KEY');
      if (!access || !secret || !env('COUPANG_TRACKING_CODE')) return fail('coupang_secrets_missing', 503);
      const protectedValues = [access, secret, apiKey, bearer, bearer.slice(7), env('SUPABASE_SERVICE_ROLE_KEY')].filter(Boolean);
      const safeText = text => protectedValues.some(value => text.includes(value))
        || /\b(?:Bearer\s|CEA\s|signature\s*[:=])/i.test(text) ? '[redacted]' : text;
      const safe = value => {
        if (typeof value === 'string') return safeText(value);
        if (Array.isArray(value)) return value.map(safe);
        if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [
          safeText(key), /authorization|secret|signature|password|access.?key|api.?key|token|service.?role/i.test(key) ? '[redacted]' : safe(item),
        ]));
        return value;
      };
      const cancellations = [], pages = [];
      for (let page = 0; page < MAX_PAGES; page++) {
        const query = new URLSearchParams({ ...range, ...(params.has('subId') ? { subId: params.get('subId') } : {}), page: String(page) }).toString();
        const auth = await authorization(access, secret, query, now());
        protectedValues.push(auth, auth.split('signature=')[1]);
        const response = await request(`https://api-gateway.coupang.com${PATH}?${query}`, {
          headers: { Authorization: auth, Accept: 'application/json' },
        });
        if (!response.ok) return fail('coupang_http_error', 502, { upstreamStatus: response.status, page });
        let payload;
        try {
          // Preserve numeric identifiers exactly; fail closed on runtimes without source support.
          payload = JSON.parse(await response.text(), (key, value, context) => {
            if (typeof value === 'number' && /Id$/.test(key)) {
              if (!Number.isSafeInteger(value) && !context?.source) throw Error('unsafe_id');
              return context?.source ?? String(value);
            }
            return value;
          });
        } catch { return fail('coupang_invalid_json_or_unsafe_id', 502, { page }); }
        if (String(payload?.rCode) !== '0') return fail('coupang_report_error', 502, { page });
        if (!Array.isArray(payload.data) || payload.data.length > PAGE_SIZE
          || payload.data.some(row => !row || typeof row !== 'object' || Array.isArray(row))) return fail('coupang_unexpected_schema', 502, { page });
        cancellations.push(...payload.data.map(safe));
        pages.push({ page, count: payload.data.length });
        if (payload.data.length < PAGE_SIZE) {
          const result = { success: true, ...range, count: cancellations.length, cancellations };
          if (params.get('debug') === 'true') result.debug = {
            pages, records: cancellations.map((row, index) => ({ index, keys: Object.keys(row) })),
          };
          return json(result);
        }
      }
      return fail('pagination_limit_exceeded', 502);
    } catch (error) {
      const timeout = ['TimeoutError', 'AbortError'].includes(error?.name);
      console.error('coupang-cancellations', timeout ? 'timeout' : 'request_failed');
      return fail(timeout ? 'upstream_timeout' : 'request_failed', timeout ? 504 : 502);
    }
  };
}
