(() => {
  const endpoint = 'https://pqlombgqscbacjkudirl.supabase.co/functions/v1/coupang-deeplink';
  const button = document.getElementById('coupang-entry');
  const status = document.getElementById('coupang-entry-status');
  let busy = false;
  button.addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    button.disabled = true;
    button.textContent = '쿠팡 연결 중...';
    status.textContent = '';
    try {
      const response = await fetch(endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ coupangUrl: 'https://www.coupang.com/' }), signal: AbortSignal.timeout(20000),
      });
      const data = await response.json();
      if (!response.ok || data.success !== true) throw new Error();
      const url = new URL(data.shortenUrl);
      if (url.protocol !== 'https:' || !['link.coupang.com', 'coupa.ng'].includes(url.hostname) || url.username || url.password || url.port) throw new Error();
      window.location.assign(data.shortenUrl);
    } catch {
      status.textContent = '쿠팡에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.';
      busy = false;
      button.disabled = false;
      button.textContent = '쿠팡으로 이동';
    }
  });
  window.addEventListener('pageshow', () => {
    busy = false;
    button.disabled = false;
    button.textContent = '쿠팡으로 이동';
  });
})();
