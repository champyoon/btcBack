(() => {
  const endpoint = 'https://pqlombgqscbacjkudirl.supabase.co/functions/v1/coupang-deeplink';
  const button = document.getElementById('coupang-anchor-prepare');
  const link = document.getElementById('coupang-anchor-link');
  const status = document.getElementById('coupang-anchor-status');
  let busy = false, used = false;
  button.addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    button.disabled = true;
    button.textContent = '쿠팡 연결 중...';
    status.textContent = '';
    link.hidden = true;
    link.removeAttribute('href');
    try {
      const response = await fetch(endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ coupangUrl: 'https://www.coupang.com/' }), signal: AbortSignal.timeout(20000),
      });
      const data = await response.json();
      if (!response.ok || data.success !== true) throw new Error();
      const url = new URL(data.shortenUrl);
      if (url.protocol !== 'https:' || !['link.coupang.com', 'coupa.ng'].includes(url.hostname) || url.username || url.password || url.port) throw new Error();
      link.href = data.shortenUrl;
      used = false;
      button.hidden = true;
      link.hidden = false;
      status.textContent = '링크가 준비되었습니다. 테스트 버튼을 눌러 쿠팡으로 이동하세요.';
      link.focus();
    } catch {
      status.textContent = '쿠팡에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.';
      busy = false;
    } finally {
      button.disabled = false;
      button.textContent = '쿠팡으로 이동하기 (테스트)';
    }
  });
  link.addEventListener('click', event => {
    if (used || !link.hasAttribute('href')) { event.preventDefault(); return; }
    used = true;
    // Let the trusted click perform native anchor navigation before resetting.
    setTimeout(() => {
      link.hidden = true;
      link.removeAttribute('href');
      button.hidden = false;
      busy = false;
      status.textContent = '';
    }, 0);
  });
})();
