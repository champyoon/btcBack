import { createHandler as ordersHandler, dateRange } from '../coupang-orders/handler.mjs';
import { createHandler as cancellationsHandler } from '../coupang-cancellations/handler.mjs';
import { fetchRewardQuote } from '../_shared/btc-krw-quote.mjs';

function identifier(value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw Error('invalid_report');
  const id = String(value);
  if (!/^[1-9]\d{0,39}$/.test(id)) throw Error('invalid_report');
  return id;
}

export function normalize(rows, type, range, now) {
  if (!Array.isArray(rows)) throw Error('invalid_report');
  return rows.map(row => {
    if (!row || typeof row !== 'object' || !/^\d{8}$/.test(row.date)) throw Error('invalid_report');
    dateRange(new URLSearchParams({ startDate: row.date, endDate: row.date }), now);
    if (row.date < range.startDate || row.date > range.endDate) throw Error('invalid_report');
    for (const field of ['gmv', 'commission']) {
      if (typeof row[field] !== 'number' || !Number.isFinite(row[field])
        || Math.abs(row[field]) > Number.MAX_SAFE_INTEGER
        || (type === 'PURCHASE' ? row[field] < 0 : row[field] > 0)) throw Error('invalid_report');
    }
    if (row.subId != null && (typeof row.subId !== 'string' || row.subId.length > 100)) throw Error('invalid_report');
    return {
      event_type: type, order_id: identifier(row.orderId), product_id: identifier(row.productId),
      event_date: `${row.date.slice(0, 4)}-${row.date.slice(4, 6)}-${row.date.slice(6)}`,
      sub_id: row.subId || null, gmv: row.gmv, commission: row.commission,
    };
  });
}

export function createHandler({ env, fetcher = fetch, now = () => new Date(), internalAdminId }) {
  const dependencies = { env, fetcher, now, internalAdminId };
  const orders = ordersHandler(dependencies), cancellations = cancellationsHandler(dependencies);
  const json = (body, status = 200) => Response.json(body, {
    status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  });
  return async req => {
    const fail = (error, status) => json({ success: false, error }, status);
    if (req.method !== 'POST') return fail('method_not_allowed', 405);
    const bearer = req.headers.get('Authorization');
    if (!bearer || !/^Bearer \S+$/i.test(bearer)) return fail('authentication_required', 401);
    try {
      const base = env('SUPABASE_URL'), anon = env(internalAdminId ? 'SUPABASE_SERVICE_ROLE_KEY' : 'SUPABASE_ANON_KEY');
      if (!base || !anon) return fail('server_configuration_missing', 503);
      const request = (url, options) => fetcher(url, {
        ...options, redirect: 'error', signal: AbortSignal.timeout(20000),
      });
      // Set only by the secret-authenticated daily factory, never from HTTP body/headers.
      const headers = { apikey: anon, Authorization: internalAdminId ? `Bearer ${anon}` : bearer };
      let user = { id: internalAdminId };
      if (!internalAdminId) {
        const auth = await request(`${base}/auth/v1/user`, { headers });
        if (!auth.ok) return fail('invalid_session', 401);
        user = await auth.json();
      }
      if (!/^[0-9a-f-]{36}$/i.test(user?.id ?? '')) return fail('invalid_session', 401);
      const query = new URLSearchParams({ select: 'user_id', user_id: `eq.${user.id}`, limit: '1' });
      const membership = await request(`${base}/rest/v1/admin_users?${query}`, { headers });
      if (!membership.ok) return fail('admin_check_failed', 503);
      const members = await membership.json();
      if (!Array.isArray(members) || !members.some(row => row.user_id === user.id)) return fail('admin_required', 403);
      let body, range;
      try {
        const text = await req.text();
        if (text.length > 2048) throw Error('body');
        body = JSON.parse(text);
        if (!body || Array.isArray(body) || Object.keys(body).some(key => !['startDate', 'endDate', 'orderId'].includes(key))
          || typeof body.startDate !== 'string' || typeof body.endDate !== 'string') throw Error('body');
        range = dateRange(new URLSearchParams({ startDate: body.startDate, endDate: body.endDate }), now());
        if (body.orderId !== undefined && (typeof body.orderId !== 'string' || identifier(body.orderId) !== body.orderId)) throw Error('body');
      } catch { return fail('invalid_parameters', 400); }
      const serviceKey = env('SUPABASE_SERVICE_ROLE_KEY');
      if (!serviceKey) return fail('server_configuration_missing', 503);
      const reportRequest = () => new Request(`https://internal/report?${new URLSearchParams(range)}`, { headers: { Authorization: bearer } });
      // Reuse existing handlers in-process; their auth, signing and API behavior stay unchanged.
      const orderResponse = await orders(reportRequest());
      if (!orderResponse.ok) return fail('orders_fetch_failed', 502);
      const orderData = await orderResponse.json();
      // Orders currently returns one page. Never sync a possibly truncated report.
      if (!Array.isArray(orderData.orders) || orderData.orders.length >= 1000) return fail('orders_scope_too_large', 422);
      const cancelResponse = await cancellations(reportRequest());
      if (!cancelResponse.ok) return fail('cancellations_fetch_failed', 502);
      const cancelData = await cancelResponse.json();
      let events;
      try {
        events = [...normalize(orderData.orders, 'PURCHASE', range, now()),
          ...normalize(cancelData.cancellations, 'CANCEL', range, now())];
        if (events.length > 5000) return fail('sync_scope_too_large', 422);
        if (body.orderId) events = events.filter(row => row.order_id === body.orderId);
      } catch { return fail('invalid_report', 502); }
      let quote;
      // Daily freezes `now` for report dates; freshness must use the actual fetch time.
      try { quote = await fetchRewardQuote({ fetcher }); }
      catch { return fail('reward_price_unavailable', 502); }
      const response = await request(`${base}/rest/v1/rpc/sync_coupang_rewards`, {
        method: 'POST', headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ p_admin_id: user.id, p_events: events,
          p_btc_krw_rate: quote.rate, p_btc_rate_at: quote.rateAt, p_btc_rate_source: quote.source }),
      });
      // Never expose PostgREST exception details, request bodies or credentials.
      if (!response.ok) return fail('sync_database_rejected', 409);
      const result = await response.json();
      return json({ success: true, ...range, result });
    } catch {
      return fail('sync_request_failed', 502);
    }
  };
}
