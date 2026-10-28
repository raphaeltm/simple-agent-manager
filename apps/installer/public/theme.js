// Same preference values and system default as the homepage, scoped to this origin.
(() => {
  const system = matchMedia('(prefers-color-scheme: light)');
  let preference = 'auto';
  try {
    const saved = localStorage.getItem('starlight-theme');
    if (saved === 'light' || saved === 'dark') preference = saved;
  } catch {
    /* Private browsing can disable storage. */
  }
  const apply = () => {
    document.documentElement.dataset.theme =
      preference === 'auto' ? (system.matches ? 'light' : 'dark') : preference;
  };
  apply();
  system.addEventListener('change', apply);
  document.addEventListener('DOMContentLoaded', () => {
    const picker = document.getElementById('theme');
    picker.value = preference;
    picker.addEventListener('change', () => {
      preference = picker.value;
      apply();
      try {
        localStorage.setItem('starlight-theme', preference);
      } catch {
        /* Theme still works. */
      }
    });
  });
})();
