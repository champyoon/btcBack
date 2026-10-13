import { dateRange } from '../coupang-orders/handler.mjs';
import { createHandler as syncHandler } from '../coupang-reward-sync/handler.mjs';

export function dailyRange(now = new Date()) {
  return dateRange(new URLSearchParams(), now);
}

async function authenticatedRequest(req, secret, instant) {
  const timestamp = req.headers.get('x-btcback-cron-timestamp');
  const signature = req.headers.get('x-btcback-cron-signature');
  if (!/^\d{10}$/.test(timestamp ?? '') || !/^[a-f0-9]{64}$/.test(signature ?? '')) return false;
  const age = instant.getTime() / 1000 - Number(timestamp);
  if (!Number.isFinite(age) || age < -30 || age > 300) return false;
  const bytes = hex => Uint8Array.from(hex.match(/../g), value => parseInt(value, 16));
  const key = await crypto.subtle.importKey('raw', bytes(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const message = `btcback-daily-v1\nPOST\n/functions/v1/coupang-reward-daily\n${timestamp}\n{}`;
  return crypto.subtle.verify('HMAC', key, bytes(signature), new TextEncoder().encode(message));
}

export function createHandler({ env, fetcher = fetch, now = () => new Date(), logger = console.info }) {
  const json = (body, status) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
  return async req => {
    const fail = (error, status) => {
      logger('coupang-reward-daily', { success: false, error, status });
      return json({ success: false, error }, status);
    };
    if (req.method !== 'POST') return fail('method_not_allowed', 405);
    try {
      const secret = env('COUPANG_DAILY_SYNC_SECRET');
      if (!/^[a-f0-9]{64}$/.test(secret ?? '')) return fail('daily_configuration_missing', 503);
      const instant = now();
      if (!await authenticatedRequest(req, secret, instant)) return fail('daily_authentication_required', 401);
      // The scheduler may trigger only the current seven-day range, not arbitrary inputs.
      if (new URL(req.url).search) return fail('daily_parameters_not_allowed', 400);
      const text = await req.text();
      let body;
      try { body = text ? JSON.parse(text) : {}; } catch { return fail('daily_parameters_not_allowed', 400); }
      if (text !== '{}' || !body || Array.isArray(body) || typeof body !== 'object' || Object.keys(body).length) {
        return fail('daily_parameters_not_allowed', 400);
      }
      const internalAdminId = env('COUPANG_SYNC_ADMIN_ID');
      const serviceKey = env('SUPABASE_SERVICE_ROLE_KEY');
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(internalAdminId ?? '') || !serviceKey) {
        return fail('daily_configuration_missing', 503);
      }
      const range = dailyRange(instant);
      const sync = syncHandler({ env, fetcher, now: () => instant, internalAdminId });
      const response = await sync(new Request('https://internal/coupang-reward-sync', {
        method: 'POST', headers: { Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(range),
      }));
      const result = await response.json();
      logger('coupang-reward-daily', { ...range, success: response.ok && result.success === true,
        status: response.status, skippedOrders: Array.isArray(result.result?.skipped) ? result.result.skipped.length : 0 });
      return json(result, response.status);
    } catch {
      return fail('daily_execution_failed', 502);
    }
  };
}
