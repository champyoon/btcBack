(() => {
  const endpoint = 'https://pqlombgqscbacjkudirl.supabase.co/functions/v1/coupang-deeplink-no-subid';
  const button = document.getElementById('coupang-no-subid-prepare');
  const status = document.getElementById('coupang-no-subid-status');
  let busy = false;
  button.addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    button.disabled = true;
    button.textContent = '쿠팡 연결 중...';
    status.textContent = '';
    let unassigned = false;
    try {
      const session = await window.BTCBackMember?.getSession();
      const token = session?.data?.session?.access_token;
      if (session?.error || !token) throw new Error();
      const response = await fetch(endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ coupangUrl: 'https://www.coupang.com/' }), signal: AbortSignal.timeout(20000),
      });
      const data = await response.json();
      unassigned = response.status === 403 && data.success === false && ['coupang_access_unavailable', 'coupang_access_unassigned'].includes(data.error);
      if (!response.ok || data.success !== true) throw new Error();
      const url = new URL(data.shortenUrl);
      if (url.protocol !== 'https:' || !['link.coupang.com', 'coupa.ng'].includes(url.hostname) || url.username || url.password || url.port) throw new Error();
      window.location.assign(data.shortenUrl);
    } catch {
      status.textContent = unassigned ? '현재 이 계정에서는 쿠팡 리워드를 이용할 수 없습니다.' : '쿠팡에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.';
      busy = false;
      button.disabled = false;
      button.textContent = '쿠팡으로 이동';
    }
  });
  window.addEventListener('pageshow', event => {
    if (event.persisted) {
      busy = false;
      button.disabled = false;
      button.textContent = '쿠팡으로 이동';
    }
  });
})();
