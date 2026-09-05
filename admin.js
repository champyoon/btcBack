(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const statuses = ['pending', 'purchase_confirmed', 'reward_confirmed', 'paid', 'rejected'];
  const nextStatus = { pending: 'purchase_confirmed', purchase_confirmed: 'reward_confirmed', reward_confirmed: 'paid' };
  const actionLabels = { purchase_confirmed: '구매 확인', reward_confirmed: '리워드 확정', paid: '지급 완료' };
  const columns = 'id,created_at,store_name,purchase_date,purchase_amount,order_number,customer_name,email,lightning_destination,memo,status';
  const pageSize = 25;
  let client, adminId = null, authVersion = 0, loadVersion = 0;
  let page = 0, total = 0, rows = [], loading = false, updating = false, signingIn = false;
  function message(id, text, error = false) {
    const node = $(id); node.textContent = text; node.hidden = !text;
    node.className = `message ${error ? 'error' : 'success'}`;
  }
  function report(operation, error) {
    console.error(`[BTCBack admin] ${operation}`, { code: error?.code || null, status: error?.status || null, name: error?.name || 'Error' });
  }
  function clearPrivateView() {
    ++authVersion; ++loadVersion; adminId = null; rows = []; total = 0; page = 0;
    loading = false; updating = false;
    $('dashboard').hidden = true; $('login-panel').hidden = false; $('logout').hidden = true;
    $('requests').replaceChildren(); $('detail-fields').replaceChildren(); $('detail').close();
    $('account').textContent = ''; $('page-summary').textContent = '';
    document.querySelectorAll('.stat strong').forEach(node => { node.textContent = '-'; });
  }
  function controls() {
    const busy = loading || updating;
    $('refresh').disabled = busy; $('status-filter').disabled = busy;
    $('previous').disabled = busy || page === 0;
    $('next').disabled = busy || (page + 1) * pageSize >= total;
    document.querySelectorAll('[data-update]').forEach(button => { button.disabled = busy; });
  }
  const formatTime = value => new Date(value).toLocaleString('ko-KR', { hour12: false });
  const money = value => `${Number(value).toLocaleString('ko-KR')}원`;
  function cell(row, value, secondary) {
    const td = document.createElement('td'); td.textContent = value ?? '-';
    td.dataset.label = ['접수 일시', '구매 정보', '신청자', '구매금액', '상태', '상세', '상태 변경'][row.children.length];
    if (secondary) { const small = document.createElement('small'); small.textContent = secondary; td.append(small); }
    row.append(td); return td;
  }
  function details(row) {
    const values = [ ['신청 ID', row.id], ['접수 일시', formatTime(row.created_at)], ['구매 쇼핑몰', row.store_name], ['구매일', row.purchase_date], ['구매금액', money(row.purchase_amount)], ['주문번호', row.order_number], ['이름 / 닉네임', row.customer_name], ['이메일', row.email], ['Lightning 수령 정보', row.lightning_destination], ['메모', row.memo], ['상태', row.status] ];
    $('detail-fields').replaceChildren(...values.flatMap(([name, value]) => {
      const dt = document.createElement('dt'), dd = document.createElement('dd');
      dt.textContent = name; dd.textContent = value || '-'; return [dt, dd];
    }));
    $('detail').showModal();
  }
  function render() {
    $('requests').replaceChildren(...rows.map(row => {
      const tr = document.createElement('tr');
      cell(tr, formatTime(row.created_at)); cell(tr, row.store_name, row.purchase_date);
      cell(tr, row.customer_name, row.email); cell(tr, money(row.purchase_amount));
      const badge = document.createElement('span'); badge.className = 'status'; badge.dataset.status = row.status; badge.textContent = row.status;
      cell(tr, '').append(badge);
      const detail = document.createElement('button'); detail.className = 'secondary'; detail.textContent = '상세'; detail.addEventListener('click', () => details(row)); cell(tr, '').append(detail);
      const actions = document.createElement('div'); actions.className = 'actions';
      [nextStatus[row.status], row.status !== 'rejected' ? 'rejected' : null].filter(Boolean).forEach(target => {
        const button = document.createElement('button'); button.className = `action${target === 'rejected' ? ' reject' : ''}`;
        button.dataset.update = target; button.textContent = target === 'rejected' ? '반려' : actionLabels[target];
        button.addEventListener('click', () => changeStatus(row, target)); actions.append(button);
      });
      cell(tr, '').append(actions); return tr;
    }));
    $('empty').hidden = rows.length > 0;
    $('page-number').textContent = String(page + 1);
    $('page-summary').textContent = total ? `${total.toLocaleString('ko-KR')}건 · ${page * pageSize + 1}–${Math.min((page + 1) * pageSize, total)}` : '0건';
    controls();
  }
  async function membership(userId) {
    const { data, error } = await client.from('admin_users').select('user_id').eq('user_id', userId).maybeSingle();
    if (error) throw error;
    return Boolean(data && data.user_id === userId);
  }
  async function load() {
    if (!adminId) return;
    const version = ++loadVersion, owner = adminId;
    loading = true; controls(); message('dashboard-message', '신청 목록을 불러오고 있습니다.');
    try {
      if (!await membership(owner)) {
        if (version !== loadVersion) return;
        clearPrivateView(); message('auth-message', '관리자 권한이 없습니다.', true); return;
      }
      if (version !== loadVersion) return;
      let query = client.from('reward_requests').select(columns, { count: 'exact' }).order('created_at', { ascending: false }).order('id', { ascending: false });
      const filter = $('status-filter').value;
      if (filter) query = query.eq('status', filter);
      const counts = ['', ...statuses.slice(0, 4)].map(status => {
        let query = client.from('reward_requests').select('id', { count: 'exact', head: true });
        return status ? query.eq('status', status) : query;
      });
      const results = await Promise.all([query.range(page * pageSize, (page + 1) * pageSize - 1), ...counts]);
      if (version !== loadVersion || owner !== adminId) return;
      const failed = results.find(result => result.error); if (failed) throw failed.error;
      total = results[0].count || 0;
      if (page > 0 && page * pageSize >= total) { page = Math.max(0, Math.ceil(total / pageSize) - 1); await load(); return; }
      rows = results[0].data || [];
      ['all', ...statuses.slice(0, 4)].forEach((status, index) => { $(`count-${status}`).textContent = results[index + 1].count.toLocaleString('ko-KR'); });
      render(); message('dashboard-message', '');
    } catch (error) {
      if (version !== loadVersion) return;
      report('load', error); rows = []; total = 0; render();
      document.querySelectorAll('.stat strong').forEach(node => { node.textContent = '-'; });
      message('dashboard-message', '목록을 불러오지 못했습니다. 연결과 관리자 권한을 확인한 후 새로고침해 주세요.', true);
    } finally { if (version === loadVersion) { loading = false; controls(); } }
  }
  async function changeStatus(row, target) {
    if (!adminId || updating || loading) return;
    const warning = target === 'paid' ? '실제로 Bitcoin 지급을 완료했는지 확인하세요.\n이 작업은 Bitcoin을 전송하지 않습니다.\n\n' : '';
    if (!window.confirm(`${warning}${row.customer_name}님의 신청을 ${row.status} → ${target} 상태로 변경하시겠습니까?`)) return;
    updating = true; controls(); const owner = adminId, version = authVersion;
    try {
      // Compare the previous status to avoid overwriting another administrator's update.
      const { data, error } = await client.from('reward_requests').update({ status: target }).eq('id', row.id).eq('status', row.status).select('id,status');
      if (version !== authVersion || owner !== adminId) return;
      if (error) throw error;
      if (data?.length !== 1) throw Object.assign(new Error('Conflict or access revoked'), { code: 'CONFLICT_OR_DENIED' });
      row.status = data[0].status; render(); await load();
      if (version === authVersion && !$('dashboard-message').classList.contains('error')) message('dashboard-message', '상태를 변경했습니다.');
    } catch (error) {
      if (version !== authVersion) return;
      report('update', error);
      message('dashboard-message', '상태 변경을 확인하지 못했습니다. 새로고침으로 현재 상태와 권한을 확인해 주세요.', true);
    } finally { if (version === authVersion) { updating = false; controls(); } }
  }
  async function authorize() {
    clearPrivateView(); const version = authVersion;
    $('login-button').disabled = true;
    try {
      const { data, error } = await client.auth.getUser();
      if (version !== authVersion) return;
      if (error || !data.user) {
        if (error && error.name !== 'AuthSessionMissingError') report('session', error);
        return;
      }
      const allowed = await membership(data.user.id);
      if (version !== authVersion) return;
      if (!allowed) {
        await client.auth.signOut({ scope: 'local' });
        message('auth-message', '관리자로 등록되지 않은 계정입니다. 접근할 수 없습니다.', true); return;
      }
      adminId = data.user.id; $('account').textContent = data.user.email || '';
      $('login-panel').hidden = true; $('dashboard').hidden = false; $('logout').hidden = false;
      message('auth-message', ''); await load();
    } catch (error) {
      if (version === authVersion) { report('authorization', error); message('auth-message', '관리자 권한을 확인하지 못했습니다. 잠시 후 다시 로그인해 주세요.', true); }
    } finally { if (version === authVersion) $('login-button').disabled = false; }
  }
  $('login-form').addEventListener('submit', async event => {
    event.preventDefault(); if (!client || signingIn) return;
    signingIn = true; $('login-button').disabled = true; message('auth-message', '');
    try {
      const { error } = await client.auth.signInWithPassword({ email: $('email').value.trim(), password: $('password').value });
      if (error) throw error;
      $('password').value = '';
    } catch (error) { report('login', error); message('auth-message', '로그인하지 못했습니다. 이메일과 비밀번호를 확인해 주세요.', true); }
    finally { signingIn = false; $('login-button').disabled = false; }
  });
  $('logout').addEventListener('click', async () => {
    clearPrivateView();
    const { error } = await client.auth.signOut({ scope: 'local' });
    if (error) { report('logout', error); sessionStorage.removeItem('btcback-admin-auth'); location.reload(); }
  });
  $('refresh').addEventListener('click', load);
  $('status-filter').addEventListener('change', () => { page = 0; load(); });
  $('previous').addEventListener('click', () => { if (page > 0 && !loading) { page--; load(); } });
  $('next').addEventListener('click', () => { if ((page + 1) * pageSize < total && !loading) { page++; load(); } });
  $('close-detail').addEventListener('click', () => $('detail').close());
  try {
    const url = new URL(ADMIN_SUPABASE_URL);
    const key = ADMIN_SUPABASE_KEY;
    const token = key.split('.');
    const role = token.length === 3 ? JSON.parse(atob(token[1].replace(/-/g, '+').replace(/_/g, '/'))).role : null;
    if (url.protocol !== 'https:' || (!/^sb_publishable_[A-Za-z0-9_-]+$/.test(key) && role !== 'anon')) throw new Error('Invalid public configuration');
    client = window.supabase.createClient(ADMIN_SUPABASE_URL, key, { auth: { storageKey: 'btcback-admin-auth', storage: sessionStorage, persistSession: true, autoRefreshToken: true, detectSessionInUrl: false } });
    client.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT') { clearPrivateView(); $('login-button').disabled = false; }
      if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') setTimeout(authorize, 0);
    });
    authorize();
  } catch (error) { report('initialization', error); message('auth-message', '관리자 연결 설정 또는 네트워크를 확인해 주세요.', true); }
})();
