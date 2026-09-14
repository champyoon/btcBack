(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  let client, adminId = null, authVersion = 0;
  let signingIn = false;
  function message(id, text, error = false) {
    const node = $(id); node.textContent = text; node.hidden = !text;
    node.className = `message ${error ? 'error' : 'success'}`;
  }
  function report(operation, error) {
    console.error(`[BTCBack admin] ${operation}`, { code: error?.code || null, status: error?.status || null, name: error?.name || 'Error' });
  }
  function clearPrivateView() {
    ++authVersion; adminId = null;
    $('dashboard').hidden = true; $('login-panel').hidden = false; $('logout').hidden = true;
    $('account').textContent = '';
  }
  async function membership(userId) {
    const { data, error } = await client.from('admin_users').select('user_id').eq('user_id', userId).maybeSingle();
    if (error) throw error;
    return Boolean(data && data.user_id === userId);
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
      message('auth-message', '');
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
