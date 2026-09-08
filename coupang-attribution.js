(() => {
  const endpoint = 'https://pqlombgqscbacjkudirl.supabase.co/functions/v1/coupang-deeplink';
  const form = document.getElementById('attribution-form');
  const input = document.getElementById('attribution-url');
  const button = document.getElementById('attribution-submit');
  const status = document.getElementById('attribution-status');
  const link = document.getElementById('attribution-link');
  let busy = false;
  const clearLink = () => { link.hidden = true; link.removeAttribute('href'); };
  input.addEventListener('input', clearLink);
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy) return;
    clearLink();
    busy = true;
    button.disabled = input.disabled = true;
    status.textContent = '테스트 링크를 생성하고 있습니다.';
    try {
      const response = await fetch(endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ coupangUrl: input.value.trim() }), signal: AbortSignal.timeout(20000),
      });
      const data = await response.json();
      if (!response.ok || data.success !== true) throw new Error();
      const url = new URL(data.shortenUrl);
      if (url.protocol !== 'https:' || !['link.coupang.com', 'coupa.ng'].includes(url.hostname) || url.username || url.password || url.port) throw new Error();
      link.href = data.shortenUrl;
      link.hidden = false;
      status.textContent = '테스트 링크가 생성되었습니다. 아래 버튼으로 이동하세요.';
    } catch {
      status.textContent = '링크를 생성하지 못했습니다. 쿠팡 URL과 함수 배포 상태를 확인해 주세요.';
    } finally { busy = false; button.disabled = input.disabled = false; }
  });
})();
