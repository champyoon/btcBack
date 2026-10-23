(() => {
  'use strict';
  const dashboard = document.getElementById('member-dashboard');
  if (!dashboard) return;
  const field = name => dashboard.querySelector(`[data-field="${name}"]`);
  const message = document.getElementById('rewards-message');
  const retry = document.getElementById('rewards-retry');
  const labels = { CONFIRMED: '적립 완료', PENDING: '확인 중', PAID: '지급 완료', CANCELLED: '취소됨' };
  const merchants = { COUPANG: 'Coupang', IHERB: 'iHerb', TRIPCOM: 'Trip.com' };
  let historyRows = [], selectedType = 'ALL', visibleCount = 10;
  const more = document.getElementById('history-more');
  const tabs = [...dashboard.querySelectorAll('[data-history-type]')];
  function renderHistory() {
    const rows = historyRows.filter(row => selectedType === 'ALL' || row.source_type === selectedType);
    const fragment = document.createDocumentFragment();
    const dateFormat = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' });
    for (const row of rows.slice(0, visibleCount)) {
      const item = document.createElement('tr'), dateCell = document.createElement('td'), detail = document.createElement('td'), amountCell = document.createElement('td');
      item.className = 'history-item'; item.dataset.status = row.status;
      const date = document.createElement('time');
      date.dateTime = row.created_at; date.textContent = dateFormat.format(new Date(row.created_at)).replaceAll('-', '.');
      dateCell.append(date);
      const name = document.createElement('span'), status = document.createElement('small');
      const merchant = row.merchant === 'COUPANG' ? '쿠팡' : (merchants[row.merchant] || row.merchant || '');
      name.textContent = row.source_type === 'ATTENDANCE' ? '출석 Reward' : row.source_type === 'SHOPPING' ? `${merchant || '쇼핑'}${merchant ? ' 쇼핑' : ' Reward'}` : 'Reward';
      status.textContent = labels[row.status];
      detail.append(name, status);
      if (row.source_type === 'SHOPPING' && row.purchase_currency === 'KRW' && row.purchase_amount != null) {
        try {
          const purchase = document.createElement('small');
          purchase.className = 'history-purchase'; purchase.textContent = `₩${format(sats(row.purchase_amount))}`;
          detail.append(purchase);
        } catch { /* Optional purchase amounts must not hide history. */ }
      }
      const amount = document.createElement('strong');
      amount.textContent = `${row.status === 'CANCELLED' ? '' : '+'}${format(row.amount)} sats`;
      amountCell.append(amount); item.append(dateCell, detail, amountCell); fragment.append(item);
    }
    if (!rows.length) {
      const item = document.createElement('tr'), cell = document.createElement('td');
      cell.colSpan = 3; cell.textContent = '아직 Reward 기록이 없습니다.'; item.append(cell); fragment.append(item);
    }
    field('reward_history').replaceChildren(fragment);
    more.hidden = rows.length <= visibleCount;
  }
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => {
      selectedType = tab.dataset.historyType; visibleCount = 10;
      tabs.forEach(button => { const active = button === tab; button.setAttribute('aria-selected', String(active)); button.tabIndex = active ? 0 : -1; });
      renderHistory();
    });
    tab.addEventListener('keydown', event => {
      const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : null;
      if (next !== null) { event.preventDefault(); tabs[next].focus(); tabs[next].click(); }
    });
  });
  more.addEventListener('click', () => { visibleCount += 10; renderHistory(); });
  let revision = 0;
  let priceController;
  const format = value => value.toLocaleString('en-US');
  function clearQuote() {
    field('btc_krw_price').textContent = '-';
    const time = field('price_time');
    time.textContent = ''; time.hidden = true;
    time.removeAttribute('datetime'); time.removeAttribute('title');
  }
  function reset() {
    ++revision;
    historyRows = []; visibleCount = 10; more.hidden = true;
    priceController?.abort();
    field('current_value_krw').textContent = '-';
    field('current_value_krw').classList.remove('is-message');
    clearQuote();
    for (const name of ['total_sats_earned','btc_amount']) field(name).textContent = '-';
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
  function currentWon(earned, price) {
    // Preserve bigint sats precision; round the final positive KRW value half-up.
    const [mantissa, exponent = '0'] = String(price).split('e');
    const [whole, fraction = ''] = mantissa.split('.');
    const scale = fraction.length - Number(exponent);
    let numerator = earned * BigInt(whole + fraction), denominator = 100000000n;
    if (scale >= 0) denominator *= 10n ** BigInt(scale);
    else numerator *= 10n ** BigInt(-scale);
    return (numerator + denominator / 2n) / denominator;
  }
  async function loadCurrentValue(earned, current) {
    const value = field('current_value_krw');
    if (earned === 0n) { value.textContent = '약 ₩0'; return; }
    value.textContent = '불러오는 중...';
    value.classList.add('is-message');
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
      const priceAt = typeof data.price_at === 'string' ? Date.parse(data.price_at) : NaN;
      const age = Date.now() - priceAt;
      if (!Number.isFinite(priceAt) || age > 300000 || age < -30000) throw new Error('Stale price');
      if (current !== revision) return;
      value.textContent = `약 ₩${format(currentWon(earned, data.price))}`;
      value.classList.remove('is-message');
      field('btc_krw_price').textContent = `₩${data.price.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
      const time = field('price_time');
      time.dateTime = data.price_at;
      time.textContent = `${new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(priceAt))} 기준 (KST)`;
      time.title = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'medium', timeStyle: 'medium' }).format(new Date(priceAt));
      time.hidden = false;
    } catch {
      if (current !== revision) return;
      console.error('[BTCBack price] Current value unavailable');
      value.textContent = '현재 가치를 불러올 수 없습니다.';
      value.classList.add('is-message');
      clearQuote();
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
          .select('id,user_id,source_type,merchant,purchase_amount,purchase_currency,amount_sats,status,created_at,confirm_eligible_at', { count: 'exact' })
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
      // Current reward rows already contain net sats after partial cancellations.
      const earned = rows.filter(row => ['PENDING','CONFIRMED','PAID'].includes(row.status)).reduce((sum,row) => sum + row.amount, 0n);
      field('total_sats_earned').textContent = format(earned);
      field('btc_amount').textContent = `${earned / 100000000n}.${String(earned % 100000000n).padStart(8,'0')}`;
      historyRows = rows;
      renderHistory();
      message.textContent = '';
      void loadCurrentValue(earned, current);
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
