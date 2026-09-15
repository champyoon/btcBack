(() => {
  'use strict';
  const dashboard = document.getElementById('member-dashboard');
  const form = document.getElementById('login-form');
  const status = document.getElementById('member-status');
  const logout = document.getElementById('member-logout');
  const retry = document.getElementById('member-retry');
  const submit = document.getElementById('login-submit');
  const headerEntry = document.querySelector('.site-auth-entry');
  const headerOnly = !status;
  const nav = document.querySelector('.site-header .site-nav');
  let userInfo, userRow, attendance, attendanceUser = null;
  function updateAttendance(user) { attendanceUser = user; attendance?.setUser(user); }
  if (nav && headerEntry) {
    const account = document.createElement('div');
    account.className = 'site-account';
    userInfo = document.createElement('div');
    userInfo.className = 'site-user-info';
    userInfo.hidden = true;
    userRow = document.createElement('div');
    userRow.className = 'site-user-row';
    userRow.hidden = true;
    userRow.append(userInfo);
    nav.before(account);
    account.append(userRow, nav);
  }
  function updateEntry(signedIn, user = null) {
    if (userInfo) {
      const label = signedIn && user?.email ? `${user.email} 님` : '';
      userInfo.textContent = label;
      userInfo.title = label;
      userInfo.hidden = !label;
      userRow.hidden = !signedIn;
    }
    if (!headerEntry) return;
    headerEntry.hidden = signedIn;
    if (logout) logout.hidden = !signedIn;
  }
  let client, revision = 0, actionBusy = false;
  function hideContent() { if (dashboard) { dashboard.hidden = true; window.BTCBackRewards?.reset(); } if (form) form.hidden = true; }
  function notice(text, error = false) { if (status) { status.textContent = text; status.classList.toggle('error', error); } }
  function loginError(error) {
    if (error?.code === 'email_not_confirmed') return '이메일 인증이 필요합니다. 가입 시 받은 인증 메일을 확인해 주세요.';
    if (error?.status === 429) return '요청이 많아 잠시 제한되었습니다. 잠시 후 다시 시도해 주세요.';
    if (error?.code === 'invalid_credentials') return '이메일 또는 비밀번호를 확인해 주세요.';
    return '로그인을 완료하지 못했습니다. 연결을 확인하고 잠시 후 다시 시도해 주세요.';
  }
  async function refresh() {
    const current = ++revision;
    let sessionKnown = false;
    hideContent(); if (retry) retry.hidden = true;
    notice('회원 상태를 확인하고 있습니다.');
    try {
      const session = await client.auth.getSession();
      if (current !== revision) return;
      if (session.error) throw session.error;
      updateEntry(Boolean(session.data?.session), session.data?.session?.user);
      sessionKnown = true;
      if (session.data?.session?.user?.id !== attendanceUser?.id) updateAttendance(null);
      if (!session.data?.session) {
        updateAttendance(null);
        if (headerOnly) return;
        logout.hidden = true;
        if (dashboard) { location.replace('login.html'); return; }
        form.hidden = false; notice(''); return;
      }
      logout.hidden = false;
      const user = await client.auth.getUser();
      if (current !== revision) return;
      if (user.error || !user.data?.user) throw new Error('User unavailable');
      if (!user.data.user.email_confirmed_at) {
        updateAttendance(null);
        notice('이메일 인증이 필요합니다. 가입 시 받은 인증 메일을 확인해 주세요.', true); return;
      }
      const profile = await client.from('profiles').select('member_status').eq('id', user.data.user.id).maybeSingle();
      if (current !== revision) return;
      if (profile.error || !profile.data) throw new Error('Profile unavailable');
      updateAttendance(profile.data.member_status === 'APPROVED' ? user.data.user : null);
      if (headerOnly) return;
      switch (profile.data.member_status) {
        case 'APPROVED':
          if (dashboard) { dashboard.hidden = false; notice(''); void window.BTCBackRewards?.load(client, user.data.user.id); }
          else location.replace('shopping.html');
          break;
        case 'PENDING':
          notice('승인 대기 중입니다. BTCBack Closed Beta 참여 승인을 확인 중입니다. 승인 후 Shopping, Reward, My BTCBack 회원 기능을 이용할 수 있습니다.');
          retry.hidden = false; break;
        case 'BLOCKED':
          notice('현재 이용이 제한된 계정입니다. 도움이 필요한 경우 support@btcback.kr로 문의해 주세요.'); retry.hidden = false; break;
        default: throw new Error('Unknown status');
      }
    } catch {
      if (current === revision) { updateAttendance(null); if (headerOnly) { if (!sessionKnown) updateEntry(false); return; } notice('회원 정보를 확인할 수 없습니다. 잠시 후 다시 시도해 주세요.', true); retry.hidden = false; }
    }
  }
  form?.addEventListener('submit', async event => {
    event.preventDefault();
    if (actionBusy || !client || !form.reportValidity()) return;
    actionBusy = true; ++revision; submit.disabled = true; submit.textContent = '로그인 중...';
    try {
      const { error } = await client.auth.signInWithPassword({ email: document.getElementById('email').value.trim(), password: document.getElementById('password').value });
      if (error) notice(loginError(error), true);
      else await refresh();
    } catch { notice(loginError(null), true); }
    finally {
      document.getElementById('password').value = '';
      submit.disabled = false; submit.textContent = '로그인'; actionBusy = false;
    }
  });
  logout?.addEventListener('click', async () => {
    if (actionBusy || !client) return;
    actionBusy = true; ++revision; hideContent(); logout.disabled = true; if (retry) retry.hidden = true;
    updateAttendance(null);
    notice('로그아웃 중...');
    try {
      const { error } = await client.auth.signOut({ scope: 'local' });
      if (error) throw error;
      updateEntry(false);
      location.replace('login.html');
    } catch {
      const message = '로그아웃하지 못했습니다. 연결을 확인하고 다시 시도해 주세요.';
      if (headerOnly) window.alert(message);
      else notice(message, true);
    }
    finally { logout.disabled = false; actionBusy = false; }
  });
  retry?.addEventListener('click', () => { if (!actionBusy && client) void refresh(); });
  document.getElementById('rewards-retry')?.addEventListener('click', () => { if (!actionBusy && client) void refresh(); });
  try {
    let keyOK = typeof ADMIN_SUPABASE_KEY !== 'undefined' && /^sb_publishable_[A-Za-z0-9_-]+$/.test(ADMIN_SUPABASE_KEY);
    if (!keyOK && typeof ADMIN_SUPABASE_KEY !== 'undefined') {
      try { keyOK = JSON.parse(atob(ADMIN_SUPABASE_KEY.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).role === 'anon'; } catch { /* Invalid public key. */ }
    }
    if (!keyOK || typeof ADMIN_SUPABASE_URL === 'undefined' || ADMIN_SUPABASE_URL !== 'https://pqlombgqscbacjkudirl.supabase.co' || !window.supabase) throw new Error('Configuration');
    client = window.supabase.createClient(ADMIN_SUPABASE_URL, ADMIN_SUPABASE_KEY, { auth: {
      storageKey: 'btcback-member-auth', persistSession: true, autoRefreshToken: true, detectSessionInUrl: false
    } });
    window.BTCBackMember = { getSession: () => client.auth.getSession() };
    // Keep Auth callbacks synchronous; query only after the SDK releases its lock.
    client.auth.onAuthStateChange(event => {
      if (event === 'SIGNED_OUT') { ++revision; hideContent(); updateAttendance(null); updateEntry(false); if (logout) logout.hidden = true; }
      if (event !== 'INITIAL_SESSION' && !actionBusy) setTimeout(() => { if (!actionBusy) void refresh(); }, 0);
    });
    window.addEventListener('pagehide', () => { ++revision; hideContent(); updateAttendance(null); });
    window.addEventListener('pageshow', event => { if (event.persisted && !actionBusy) void refresh(); });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && !actionBusy) void refresh(); });
    // Attendance is optional: a module load failure must not break existing Auth.
    if (userRow) {
      void import('./member-attendance.js').then(({ createAttendance }) => {
        attendance = createAttendance({ client, row: userRow });
        attendance.setUser(attendanceUser);
      }).catch(() => {});
    }
    void refresh();
  } catch { hideContent(); notice('회원 서비스를 불러오지 못했습니다. 페이지를 다시 열어 주세요.', true); }
})();
