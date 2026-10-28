const $ = (id) => document.getElementById(id);
let busy = false;
function message(text) {
  $('message').textContent = text;
}
async function api(path, body) {
  const response = await fetch(
    `/api/session/${path}`,
    body
      ? {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }
      : {}
  );
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'The request failed. Please retry.');
  return data;
}
function render(data) {
  const ready = data.job?.status === 'ready';
  $('connect').hidden = true;
  $('account').hidden = ready;
  $('ready').hidden = !ready;
  $('disconnect').hidden = false;
  for (const id of ['step-connect', 'step-account', 'step-handoff'])
    $(id).removeAttribute('aria-current');
  $(ready ? 'step-handoff' : 'step-account').setAttribute('aria-current', 'step');
  $('account-id').replaceChildren(
    ...data.accounts.map((account) => {
      const option = document.createElement('option');
      option.value = account.id;
      option.textContent = account.name;
      return option;
    })
  );
  $('install').disabled = !data.accounts.length;
  if (!data.accounts.length)
    message(
      'No authorized accounts were found. Disconnect and try again with an account you can manage.'
    );
  if (data.job) $('worker-name').textContent = data.job.name;
  if (data.job?.status === 'pending')
    message(`Setup was interrupted. Retry to resume the same Worker: ${data.job.name}`);
}
$('install-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (busy) return;
  busy = true;
  $('install').disabled = true;
  message(
    'Creating your installation service. Keep this page open; retrying will resume the same service if interrupted.'
  );
  try {
    await api('install', { accountId: $('account-id').value, confirmed: $('confirm').checked });
    render(await api('status'));
    message('Your installation service is ready.');
  } catch (error) {
    message(error.message);
  } finally {
    busy = false;
    $('install').disabled = false;
  }
});
$('disconnect').addEventListener('click', async () => {
  if (busy) return;
  try {
    const result = await api('finish', {});
    $('connect').hidden = false;
    $('account').hidden = true;
    $('ready').hidden = true;
    $('disconnect').hidden = true;
    message(
      result.revoked
        ? 'Session cleared. Created Workers remain in your Cloudflare account.'
        : 'Session cleared locally. Revoke the installer in Cloudflare’s authorized applications to confirm access is removed.'
    );
  } catch (error) {
    message(error.message);
  }
});
(async () => {
  try {
    const config = await (await fetch('/api/config')).json();
    $('source').href = config.sourceUrl;
    $('docs').href = config.docsUrl;
    $('version').textContent = `Build ${config.sha.slice(0, 12)}`;
    $('login').disabled = !config.configured;
    if (!config.configured)
      message(
        'Cloudflare sign-in is not configured on this installer yet. See the self-hosting guide for setup.'
      );
    if (new URLSearchParams(location.search).has('error')) {
      message(
        'Cloudflare authorization was cancelled or could not be completed. Please sign in again.'
      );
      history.replaceState(null, '', '/');
    }
    const response = await fetch('/api/session/status');
    if (response.ok) render(await response.json());
    else if (response.status !== 401) message((await response.json()).error);
  } catch {
    message('The installer could not load. Please refresh to try again.');
  }
})();
