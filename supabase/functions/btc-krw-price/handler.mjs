import { fetchBtcKrwTicker } from '../_shared/btc-krw-quote.mjs';

export function createHandler({ fetcher = fetch, logger = console, timeoutMs = 8000 } = {}) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type, apikey, authorization, x-client-info',
    'Cache-Control': 'no-store',
  };
  const json = (body, status = 200) => Response.json(body, { status, headers });
  return async req => {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (req.method !== 'GET') return json({ success: false, error: 'method_not_allowed' }, 405);
    if (new URL(req.url).search) return json({ success: false, error: 'invalid_request' }, 400);
    try {
      const { price } = await fetchBtcKrwTicker({ fetcher, timeoutMs });
      return json({ success: true, market: 'KRW-BTC', price });
    } catch (error) {
      const timeout = error?.name === 'TimeoutError' || error?.name === 'AbortError';
      // Do not echo upstream bodies, request headers or raw exception messages.
      logger.error('[btc-krw-price]', { stage: 'price-fetch', timeout });
      return json({ success: false, error: timeout ? 'price_timeout' : 'price_unavailable' }, timeout ? 504 : 502);
    }
  };
}
