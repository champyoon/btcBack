const ENDPOINT = 'https://api.upbit.com/v1/ticker?markets=KRW-BTC';

export async function fetchBtcKrwTicker({ fetcher = fetch, timeoutMs = 8000 } = {}) {
  const response = await fetcher(ENDPOINT, {
    method: 'GET', headers: { Accept: 'application/json' }, redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error('Price unavailable');
  const data = await response.json();
  const price = data?.[0]?.trade_price;
  if (!Array.isArray(data) || data.length !== 1 || data[0]?.market !== 'KRW-BTC'
    || typeof price !== 'number' || !Number.isFinite(price) || price <= 0
    || price > Number.MAX_SAFE_INTEGER) throw new Error('Invalid price');
  return { price, timestamp: data[0].timestamp };
}

export async function fetchRewardQuote({ fetcher = fetch, now = () => new Date(), timeoutMs = 8000 } = {}) {
  const { price, timestamp } = await fetchBtcKrwTicker({ fetcher, timeoutMs });
  const fetchedAt = now().getTime();
  // Upbit timestamp is ticker update time, not our fetch time or trade_timestamp.
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0 || !Number.isFinite(fetchedAt)
    || fetchedAt - timestamp > 300000 || timestamp - fetchedAt > 30000
    || price !== Number(price.toFixed(2))) throw new Error('Invalid or stale quote');
  return { rate: price, rateAt: new Date(timestamp).toISOString(), source: 'upbit' };
}
