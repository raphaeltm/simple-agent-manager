// Keep the audit link tied to this deployment; fall back to the public repository.
fetch('/api/config')
  .then((response) => (response.ok ? response.json() : null))
  .then((config) => {
    if (config) {
      document.getElementById('source').href = config.sourceUrl;
      if (/^[a-f0-9]{40}$/.test(config.sha))
        document.getElementById('revision-command').textContent = `git checkout ${config.sha}\n`;
    }
  })
  .catch(() => {});
