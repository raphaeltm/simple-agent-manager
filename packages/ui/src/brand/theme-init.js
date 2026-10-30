(() => {
  const parse = (t) => (t === 'auto' || t === 'light' || t === 'dark' ? t : 'auto');
  let stored = 'auto';
  try {
    stored = parse(localStorage.getItem('starlight-theme') || 'auto');
  } catch {
    // localStorage may be unavailable (private browsing, disabled
    // storage) — fall back to the 'auto' default set above.
  }
  const resolved =
    stored === 'auto'
      ? window.matchMedia('(prefers-color-scheme: light)').matches
        ? 'light'
        : 'dark'
      : stored;
  document.documentElement.dataset.theme = resolved;
})();
