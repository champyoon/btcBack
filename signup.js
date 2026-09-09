(() => {
  'use strict';
  const form = document.getElementById('signup-form');
  const button = document.getElementById('submit');
  const message = document.getElementById('message');
  const field = id => document.getElementById(id);
  const fragment = new URLSearchParams(location.hash.slice(1));
  const query = new URLSearchParams(location.search);
  const hasCallback = ['access_token', 'refresh_token', 'error', 'error_code', 'code', 'type'].some(k => fragment.has(k) || query.has(k));
  // Remove credentials/errors before rendering or navigating. Never persist tokens.
  if (hasCallback) history.replaceState(null, '', location.pathname);
  let busy = false;
  let client;
  const show = (text, error = false) => {
    message.textContent = text;
    message.className = 'message ' + (error ? 'error' : 'success');
    message.focus({ preventScroll: true });
  };
  const signupNotice = '회원가입 요청이 완료되었습니다. 인증이 필요한 경우 입력한 이메일로 안내가 발송됩니다. 이메일의 인증 링크를 눌러 가입을 완료해 주세요. 메일이 오지 않으면 스팸함도 확인해 주세요.';
  function safeError(error) {
    if (error?.status === 429 || ['over_email_send_rate_limit', 'over_request_rate_limit'].includes(error?.code)) return '요청이 많아 잠시 제한되었습니다. 잠시 후 다시 시도해 주세요.';
    if (error?.code === 'weak_password') return '비밀번호가 서버의 보안 기준을 충족하지 않습니다. 더 길고 예측하기 어려운 비밀번호를 사용해 주세요.';
    if (['email_address_invalid', 'validation_failed'].includes(error?.code)) return '이메일과 비밀번호 입력을 확인해 주세요.';
    return '요청을 완료하지 못했습니다. 네트워크 연결을 확인하고 잠시 후 다시 시도해 주세요.';
  }
  function publicKey(key) {
    if (typeof key !== 'string') return false;
    if (/^sb_publishable_[A-Za-z0-9_-]+$/.test(key)) return true;
    try { return JSON.parse(atob(key.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).role === 'anon'; } catch { return false; }
  }
  async function verifyReturn() {
    form.hidden = true;
    show('이메일 인증 결과를 확인하고 있습니다.');
    try {
      if (fragment.has('error') || query.has('error') || fragment.get('type') !== 'signup' || !fragment.get('access_token') || !fragment.get('refresh_token')) throw new Error('Invalid callback');
      const { error: sessionError } = await client.auth.setSession({ access_token: fragment.get('access_token'), refresh_token: fragment.get('refresh_token') });
      fragment.delete('access_token');
      fragment.delete('refresh_token');
      if (sessionError) throw sessionError;
      const { data, error } = await client.auth.getUser();
      if (error || !data?.user?.email_confirmed_at) throw new Error('Unverified');
      const result = await client.from('profiles').select('member_status').eq('id', data.user.id).maybeSingle();
      if (result.error || !result.data) {
        show('이메일 인증은 확인되었지만 가입 정보 확인을 완료하지 못했습니다. 운영자에게 확인을 요청해 주세요.', true);
      } else if (result.data.member_status === 'PENDING') {
        show('이메일 인증이 완료되었습니다. BTCBack Closed Beta 회원가입이 완료되었으며, 현재 참여 승인을 기다리고 있습니다.');
      } else {
        show('이메일 인증이 확인되었습니다. 가입 상태는 운영자에게 확인해 주세요.');
      }
    } catch {
      show('인증 결과를 확인하지 못했습니다. 링크가 만료되었거나 이미 사용되었을 수 있습니다. 최신 인증 메일을 확인해 주세요.', true);
    } finally {
      fragment.delete('access_token');
      fragment.delete('refresh_token');
      client = null;
    }
  }
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy || !client) return;
    field('password-confirm').setCustomValidity('');
    if (!form.reportValidity()) return;
    if (field('password').value !== field('password-confirm').value) {
      field('password-confirm').setCustomValidity('비밀번호가 일치하지 않습니다.');
      field('password-confirm').reportValidity();
      return;
    }
    busy = true;
    button.disabled = true;
    button.textContent = '요청 중...';
    message.textContent = '';
    try {
      const { data, error } = await client.auth.signUp({ email: field('email').value.trim(), password: field('password').value, options: { emailRedirectTo: 'https://btcback.kr/signup.html' } });
      if (error && !['user_already_exists', 'email_exists', 'email_exists_not_confirmed'].includes(error.code)) {
        show(safeError(error), true);
      } else if (data?.session) {
        form.hidden = true;
        show('이메일 인증 설정 확인이 필요합니다. 가입 검증을 중단하고 운영자에게 문의해 주세요.', true);
        client = null;
      } else {
        form.hidden = true;
        show(signupNotice);
      }
    } catch {
      show(safeError(null), true);
    } finally {
      field('password').value = '';
      field('password-confirm').value = '';
      busy = false;
      button.disabled = !client;
      button.textContent = '인증 이메일 요청';
    }
  });
  field('password-confirm').addEventListener('input', () => field('password-confirm').setCustomValidity(''));
  try {
    if (!window.supabase || typeof ADMIN_SUPABASE_URL === 'undefined' || typeof ADMIN_SUPABASE_KEY === 'undefined' || !publicKey(ADMIN_SUPABASE_KEY)) throw new Error('Configuration');
    const url = new URL(ADMIN_SUPABASE_URL);
    if (url.origin !== 'https://pqlombgqscbacjkudirl.supabase.co') throw new Error('Project');
    client = window.supabase.createClient(url.origin, ADMIN_SUPABASE_KEY, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, flowType: 'implicit', storageKey: 'btcback-signup-verification' } });
    if (hasCallback) void verifyReturn();
    else button.disabled = false;
  } catch {
    show('가입 서비스를 불러오지 못했습니다. 잠시 후 페이지를 다시 열어 주세요.', true);
  }
})();
