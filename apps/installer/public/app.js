const $ = (id) => document.getElementById(id);
let busy = false;
let fullInstaller = false;
let approvedPlan;
let formRevision = 0;
let zoneLoad = 0;
let cleanupReceipt;
let currentCleanupReceipt;
let authorizedAccounts = [];
const cleanupStorageKey = 'sam-installer-cleanup';
function rememberCleanup(data) {
  if (
    !/^[a-f0-9]{64}$/.test(data?.cleanupReceipt || '') ||
    !/^[a-f0-9]{32}$/.test(data?.cleanupAccountId || '')
  )
    return;
  cleanupReceipt = { receipt: data.cleanupReceipt, accountId: data.cleanupAccountId };
  try {
    sessionStorage.setItem(cleanupStorageKey, JSON.stringify(cleanupReceipt));
  } catch {
    /* Memory-only when browser storage is unavailable. */
  }
  currentCleanupReceipt = data.currentCleanupReceipt || data.cleanupReceipt;
  renderCleanup();
}
function forgetCleanup() {
  cleanupReceipt = undefined;
  try {
    sessionStorage.removeItem(cleanupStorageKey);
  } catch {
    /* Storage can be disabled. */
  }
  renderCleanup();
}
function renderCleanup() {
  $('cleanup-panel').hidden = !cleanupReceipt;
  const canClean =
    cleanupReceipt &&
    currentCleanupReceipt !== cleanupReceipt.receipt &&
    authorizedAccounts.some((account) => account.id === cleanupReceipt.accountId);
  $('cleanup-resume').hidden = !canClean;
  $('cleanup-reconnect-form').hidden = !!canClean;
}
try {
  const saved = JSON.parse(sessionStorage.getItem(cleanupStorageKey) || 'null');
  if (saved) rememberCleanup({ cleanupReceipt: saved.receipt, cleanupAccountId: saved.accountId });
} catch {
  /* No valid saved cleanup receipt. No credential is stored here. */
}
function invalidatePlan() {
  formRevision++;
  approvedPlan = undefined;
  $('confirm').checked = false;
  if (fullInstaller) { $('install').disabled = true; $('install').className = 'sam-btn sam-btn--secondary'; $('preview').className = 'sam-btn sam-btn--primary'; }
  $('plan-summary').textContent = '';
}
async function loadZones() {
  invalidatePlan();
  const request = ++zoneLoad;
  const accountId = $('account-id').value;
  const { zones } = await api('zones', { accountId });
  if (request !== zoneLoad || accountId !== $('account-id').value) return;
  $('zone-id').replaceChildren(
    ...zones.map((zone) => {
      const option = document.createElement('option');
      option.value = zone.id;
      option.textContent = zone.name;
      return option;
    })
  );
  $('base-domain').value = zones[0] ? `sam.${zones[0].name}` : '';
}
function message(text, tone = 'notice') {
  $('message').dataset.tone = tone;
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
  rememberCleanup(data);
  if (!response.ok) throw new Error(data.error || 'The request failed. Please retry.');
  return data;
}
function progress(current) {
  const steps = ['step-connect', 'step-account', 'step-handoff'];
  steps.forEach((id, index) => {
    $(id).removeAttribute('aria-current');
    $(id).classList.toggle('completed', index < current);
    $(id).querySelector('.step-number').textContent = index < current ? '✓' : String(index + 1);
  });
  $(steps[current]).setAttribute('aria-current', 'step');
}
function render(data) {
  authorizedAccounts = data.accounts;
  currentCleanupReceipt = data.currentCleanupReceipt;
  rememberCleanup(data);
  if (data.job?.status === 'ready' && cleanupReceipt?.receipt === currentCleanupReceipt)
    forgetCleanup();
  renderCleanup();
  const ready = data.job?.status === 'ready';
  $('connect').hidden = true;
  $('account').hidden = ready;
  $('ready').hidden = !ready;
  $('disconnect').hidden = false;
  progress(ready ? 2 : 1);
  $('account-id').replaceChildren(
    ...data.accounts.map((account) => {
      const option = document.createElement('option');
      option.value = account.id;
      option.textContent = account.name;
      return option;
    })
  );
  $('install').disabled = !data.accounts.length;
  if (fullInstaller && !ready) {
    $('install').disabled = true;
    loadZones().catch((error) => message(error.message));
  }
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
    await api('install', {
      accountId: $('account-id').value,
      confirmed: $('confirm').checked,
      fingerprint: approvedPlan?.fingerprint,
    });
    render(await api('status'));
    message('Your installation service is ready.', 'success');
  } catch (error) {
    message(error.message);
  } finally {
    busy = false;
    $('install').disabled = fullInstaller && !approvedPlan;
  }
});
$('account-id').addEventListener('change', () => {
  if (fullInstaller) loadZones().catch((error) => message(error.message));
});
['zone-id', 'base-domain', 'owner-email'].forEach((id) =>
  $(id).addEventListener('input', invalidatePlan)
);
$('preview').addEventListener('click', async () => {
  if (busy) return;
  busy = true;
  invalidatePlan();
  const revision = formRevision;
  try {
    const { plan } = await api('preview', {
      accountId: $('account-id').value,
      zoneId: $('zone-id').value,
      zoneName: $('zone-id').selectedOptions[0]?.textContent,
      baseDomain: $('base-domain').value.trim().toLowerCase(),
      ownerEmail: $('owner-email').value.trim(),
    });
    if (revision !== formRevision) return;
    $('plan-summary').dataset.tone = plan.conflicts.length ? 'warning' : 'success';
    $('plan-summary').setAttribute('role', plan.conflicts.length ? 'alert' : 'status');
    const summary = $('plan-summary');
    if (plan.conflicts.length) {
      summary.textContent = `Existing DNS records block installation: ${plan.conflicts.map((record) => record.name).join(', ')}. Choose a fresh subdomain.`;
    } else {
      const title = document.createElement('h3'); title.textContent = 'Your installation plan';
      const list = document.createElement('dl'); list.className = 'plan-list';
      const row = (label, value) => {
        const group = document.createElement('div');
        const term = document.createElement('dt'); term.textContent = label;
        const detail = document.createElement('dd');
        if (typeof value === 'string') detail.textContent = value; else detail.append(value);
        group.append(term, detail); list.append(group);
      };
      const hosts = document.createElement('ul');
      plan.hostnames.forEach(host => { const li = document.createElement('li'); li.textContent = host; hosts.append(li); });
      row('Hostnames', hosts);
      row('Account address', `${plan.workersDev.action === 'create' ? 'Initialize account address' : 'Preserve account address'} ${plan.workersDev.subdomain}.workers.dev`);
      const source = document.createElement('a'); source.textContent = plan.sourceCommit.slice(0, 8);
      if (/^[a-f0-9]{40}$/.test(plan.sourceCommit)) source.href = `https://github.com/raphaeltm/simple-agent-manager/commit/${plan.sourceCommit}`;
      row('Build source', source);
      row('Cost', 'Cloudflare Workers Paid and usage charges apply. Your build runs in your account.');
      summary.replaceChildren(title, list);
    }
    if (!plan.conflicts.length) {
      approvedPlan = plan;
      $('install').disabled = false;
      $('install').className = 'sam-btn sam-btn--primary';
      $('preview').className = 'sam-btn sam-btn--secondary';
    }
  } catch (error) {
    message(error.message);
  } finally {
    busy = false;
  }
});
$('disconnect').addEventListener('click', async () => {
  if (busy) return;
  try {
    const result = await api('finish', {});
    forgetCleanup();
    $('connect').hidden = false;
    $('account').hidden = true;
    $('ready').hidden = true;
    $('disconnect').hidden = true;
    $('confirm').checked = false;
    progress(0);
    message(
      result.revoked
        ? 'Session cleared. Created Workers remain in your Cloudflare account.'
        : 'Session cleared locally. Revoke the installer in Cloudflare’s authorized applications to confirm access is removed.'
    );
  } catch (error) {
    message(error.message);
  }
});
$('cleanup-resume').addEventListener('click', async () => {
  if (busy || !cleanupReceipt) return;
  busy = true;
  $('cleanup-resume').disabled = true;
  try {
    const result = await api('reconcile-cleanup', cleanupReceipt);
    forgetCleanup();
    message(
      result.authorityPreserved
        ? 'Cleanup confirmed. Credentials owned by your installation service were preserved.'
        : 'Unused setup credentials removed. You can continue with a fresh setup.',
      'success'
    );
  } catch (error) {
    message(error.message);
  } finally {
    busy = false;
    $('cleanup-resume').disabled = false;
  }
});
void (async () => {
  try {
    const config = await (await fetch('/api/config')).json();
    fullInstaller = config.fullInstaller === true;
    $('deployment-settings').hidden = !fullInstaller;
    if (fullInstaller) {
      $('full-permissions').hidden = false;
      $('installer-mode-note').textContent =
        'Experimental full installation: your maintenance service builds and deploys the approved SAM source in your account. Review the domain, permissions and usage charges before continuing.';
      ['zone-id', 'base-domain', 'owner-email'].forEach((id) => ($(id).required = true));
      $('approval-copy').textContent =
        'Create my user-owned maintenance service and scoped deployment credentials, then build and deploy the reviewed SAM installation in my account. Cloudflare usage charges apply.';
    }
    $('source').href = config.sourceUrl;
    $('docs').href = config.docsUrl;
    $('version').textContent = `Build ${config.sha.slice(0, 12)}`;
    $('login').disabled = !config.configured;
    $('cleanup-reconnect').disabled = !config.configured;
    if (!config.configured) {
      message('Cloudflare sign-in is not available on this preview yet.');
      const guide = document.createElement('a');
      guide.href = config.docsUrl;
      guide.textContent = 'See setup options →';
      $('message').append(' ', guide);
      $('explore').href = config.docsUrl;
      $('explore-label').textContent = 'Explore setup options';
    }
    if (new URLSearchParams(location.search).has('error')) {
      message(
        'Cloudflare authorization was cancelled or could not be completed. Please sign in again.'
      );
      history.replaceState(null, '', '/');
    }
    const response = await fetch('/api/session/status');
    const data = await response.json();
    rememberCleanup(data);
    if (response.ok) render(data);
    else if (response.status !== 401 || data.cleanupReceipt) message(data.error);
  } catch {
    message('The installer could not load. Please refresh to try again.');
  }
})();
