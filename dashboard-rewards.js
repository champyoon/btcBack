(() => {
  'use strict';
  const dashboard = document.getElementById('member-dashboard');
  if (!dashboard) return;
  const field = name => dashboard.querySelector(`[data-field="${name}"]`);
  const message = document.getElementById('rewards-message');
  const retry = document.getElementById('rewards-retry');
  const labels = { CONFIRMED: '지급 확정', PENDING: '확인 중', CANCELLED: '취소됨' };
  const merchants = { COUPANG: 'Coupang', IHERB: 'iHerb', TRIPCOM: 'Trip.com' };
  let revision = 0;
  let priceController;
  const format = value => value.toLocaleString('en-US');
  function reset() {
    ++revision;
    priceController?.abort();
    field('current_value_krw').textContent = '현재 가치 · -';
    for (const name of ['total_sats_earned','btc_amount','confirmed_sats','pending_sats']) field(name).textContent = '-';
    field('reward_history').replaceChildren();
    message.textContent = 'Reward를 불러오고 있습니다.';
    message.classList.remove('error');
    retry.hidden = true;
    dashboard.setAttribute('aria-busy', 'true');
  }
  function sats(value) {
    if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0)) throw new Error('Invalid amount');
    if (!['number','string'].includes(typeof value) || !/^\d+$/.test(String(value))) throw new Error('Invalid amount');
    return BigInt(value);
  }
  function currentWon(confirmed, price) {
    // Preserve bigint sats precision; round the final positive KRW value half-up.
    const [mantissa, exponent = '0'] = String(price).split('e');
    const [whole, fraction = ''] = mantissa.split('.');
    const scale = fraction.length - Number(exponent);
    let numerator = confirmed * BigInt(whole + fraction), denominator = 100000000n;
    if (scale >= 0) denominator *= 10n ** BigInt(scale);
    else numerator *= 10n ** BigInt(-scale);
    return (numerator + denominator / 2n) / denominator;
  }
  async function loadCurrentValue(confirmed, current) {
    const value = field('current_value_krw');
    if (confirmed === 0n) { value.textContent = '현재 가치 · 약 ₩0'; return; }
    value.textContent = '현재 가치 · 불러오는 중...';
    const controller = new AbortController();
    priceController = controller;
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(new URL('/functions/v1/btc-krw-price', ADMIN_SUPABASE_URL), {
        method: 'GET', headers: { Accept: 'application/json' }, credentials: 'omit',
        cache: 'no-store', signal: controller.signal,
      });
      if (!response.ok) throw new Error('Price unavailable');
      const data = await response.json();
      if (data?.success !== true || data.market !== 'KRW-BTC' || typeof data.price !== 'number' ||
          !Number.isFinite(data.price) || data.price <= 0 || data.price > Number.MAX_SAFE_INTEGER) throw new Error('Invalid price');
      if (current !== revision) return;
      value.textContent = `현재 가치 · 약 ₩${format(currentWon(confirmed, data.price))}`;
    } catch {
      if (current !== revision) return;
      console.error('[BTCBack price] Current value unavailable');
      value.textContent = '현재 가치를 불러올 수 없습니다.';
    } finally {
      clearTimeout(timer);
      if (priceController === controller) priceController = undefined;
    }
  }
  async function load(client, userId) {
    reset();
    const current = revision;
    try {
      if (!userId) throw new Error('User unavailable');
      const rows = [], ids = new Set();
      let total;
      // Fetch every row, including data beyond PostgREST's per-request limit.
      do {
        const { data, error, count } = await client.from('rewards')
          .select('id,user_id,source_type,merchant,amount_sats,status,created_at', { count: 'exact' })
          .eq('user_id', userId).order('created_at', { ascending: false }).order('id', { ascending: false })
          .range(rows.length, rows.length + 499);
        if (current !== revision) return;
        if (error) throw error;
        if (!Array.isArray(data) || !Number.isSafeInteger(count) || count < 0 || (total !== undefined && count !== total)) throw new Error('Incomplete response');
        total = count;
        if (!data.length && rows.length < total) throw new Error('Incomplete response');
        for (const row of data) {
          if (row.user_id !== userId || !row.id || ids.has(row.id) || !Object.hasOwn(labels, row.status) || !Number.isFinite(Date.parse(row.created_at))) throw new Error('Invalid response');
          ids.add(row.id); rows.push({ ...row, amount: sats(row.amount_sats) });
        }
        if (rows.length > total) throw new Error('Inconsistent response');
      } while (rows.length < total);
      if (current !== revision) return;
      const confirmed = rows.filter(row => row.status === 'CONFIRMED').reduce((sum,row) => sum + row.amount, 0n);
      const pending = rows.filter(row => row.status === 'PENDING').reduce((sum,row) => sum + row.amount, 0n);
      field('total_sats_earned').textContent = format(confirmed);
      field('confirmed_sats').textContent = format(confirmed);
      field('pending_sats').textContent = format(pending);
      field('btc_amount').textContent = `${confirmed / 100000000n}.${String(confirmed % 100000000n).padStart(8,'0')}`;
      const list = document.createDocumentFragment();
      for (const row of rows) {
        const item = document.createElement('li'), name = document.createElement('span'), detail = document.createElement('small'), amount = document.createElement('strong');
        item.dataset.status = row.status;
        name.textContent = row.source_type === 'ATTENDANCE' ? '출석 Reward' : (Object.hasOwn(merchants,row.merchant) ? merchants[row.merchant] : (typeof row.merchant === 'string' && row.merchant ? row.merchant : 'Reward'));
        detail.textContent = `${labels[row.status]} · ${new Intl.DateTimeFormat('ko-KR', { timeZone:'Asia/Seoul', year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date(row.created_at))}`;
        amount.textContent = `${row.status === 'CANCELLED' ? '' : '+'}${format(row.amount)} sats`;
        name.append(detail); item.append(name,amount); list.append(item);
      }
      if (!rows.length) { const empty = document.createElement('li'); empty.textContent = '아직 Reward 기록이 없습니다.'; list.append(empty); }
      field('reward_history').replaceChildren(list);
      message.textContent = '';
      void loadCurrentValue(confirmed, current);
    } catch (error) {
      if (current !== revision) return;
      // Never log raw server messages, row data, session details or credentials.
      const code = typeof error?.code === 'string' && /^[A-Z0-9_]{1,32}$/.test(error.code) ? error.code : 'REWARD_READ_FAILED';
      console.error('[BTCBack rewards] SELECT failed', { code });
      message.textContent = 'Reward를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.';
      message.classList.add('error'); retry.hidden = false;
    } finally { if (current === revision) dashboard.setAttribute('aria-busy','false'); }
  }
  window.BTCBackRewards = { load, reset };
})();
