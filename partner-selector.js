(() => {
  const selector = document.querySelector('.partner-selector');
  const tabs = [...selector.querySelectorAll('[role="tab"]')];
  function initializeTripBanner() {
    const banner = document.getElementById('SB19739155');
    if (!banner || banner.hasAttribute('src')) return;
    // Same KST/seconds format as Coupang; initialize once per page, not per click.
    const timestamp = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString()
      .slice(2, 19).replace(/[-T:]/g, '');
    const url = new URL(banner.dataset.bannerUrl);
    url.searchParams.set('trip_sub1', timestamp);
    banner.src = url.href;
  }
  function select(tab, focus = false) {
    for (const item of tabs) {
      const active = item === tab;
      item.classList.toggle('active', active);
      item.setAttribute('aria-selected', String(active));
      item.tabIndex = active ? 0 : -1;
      document.getElementById(item.getAttribute('aria-controls')).hidden = !active;
    }
    if (tab.dataset.partner === 'trip') initializeTripBanner();
    if (focus) tab.focus();
  }
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => select(tab));
    tab.addEventListener('keydown', event => {
      let next;
      if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
      if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
      if (event.key === 'Home') next = 0;
      if (event.key === 'End') next = tabs.length - 1;
      if (next === undefined) return;
      event.preventDefault();
      select(tabs[next], true);
    });
  });
})();
