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
  $('review-form').hidden = true;
  $('review-blocked').hidden = true;
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
  // Default to the zone apex: Cloudflare's free certificate covers it and one
  // label below, which is every hostname SAM serves to a browser.
  $('base-domain').value = zones[0] ? zones[0].name : '';
  $('base-domain-shown').textContent = $('base-domain').value;
}
function message(text, tone = 'notice') {
  const el = $('message');
  el.dataset.tone = tone;
  el.replaceChildren();
  // Server errors append " Details: <technical>. No credentials were logged." —
  // keep the plain-language summary visible and tuck the rest behind a disclosure.
  const marker = ' Details: ';
  const at = typeof text === 'string' ? text.indexOf(marker) : -1;
  if (at === -1) {
    el.textContent = text;
    return;
  }
  const summary = document.createElement('p');
  summary.textContent = text.slice(0, at);
  const details = document.createElement('details');
  const technical = document.createElement('summary');
  technical.textContent = 'Technical details';
  const body = document.createElement('p');
  body.className = 'small';
  body.textContent = text.slice(at + marker.length);
  details.append(technical, body);
  el.append(summary, details);
}
function screen(name) {
  for (const id of ['connect', 'choose', 'review', 'ready']) $(id).hidden = id !== name;
}
function returnToConnect(text) {
  forgetCleanup();
  invalidatePlan();
  $('confirm').checked = false;
  $('confirm-full').checked = false;
  screen('connect');
  $('disconnect').hidden = true;
  progress(0);
  message(text);
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
  if (response.status === 401) {
    returnToConnect(
      "Your session expired after 15 minutes. Sign in again to continue."
    );
    throw new Error('session-expired');
  }
  rememberCleanup(data);
  if (!response.ok) throw new Error(data.error || 'The request failed. Please retry.');
  return data;
}
function stepOrder() {
  return fullInstaller
    ? ['step-connect', 'step-choose', 'step-review', 'step-handoff']
    : ['step-connect', 'step-choose', 'step-handoff'];
}
function progress(current) {
  $('step-review').hidden = !fullInstaller;
  const steps = stepOrder();
  steps.forEach((id, index) => {
    $(id).removeAttribute('aria-current');
    $(id).classList.toggle('completed', index < current);
    $(id).querySelector('.step-number').textContent = index < current ? '✓' : String(index + 1);
  });
  $(steps[current]).setAttribute('aria-current', 'step');
}
function stepIndex(name) {
  const map = fullInstaller
    ? { connect: 0, choose: 1, review: 2, ready: 3 }
    : { connect: 0, choose: 1, review: 1, ready: 2 };
  return map[name];
}
function render(data) {
  authorizedAccounts = data.accounts;
  currentCleanupReceipt = data.currentCleanupReceipt;
  rememberCleanup(data);
  if (data.job?.status === 'ready' && cleanupReceipt?.receipt === currentCleanupReceipt)
    forgetCleanup();
  renderCleanup();
  const ready = data.job?.status === 'ready';
  screen(ready ? 'ready' : 'choose');
  $('disconnect').hidden = false;
  progress(stepIndex(ready ? 'ready' : 'choose'));
  $('account-id').replaceChildren(
    ...data.accounts.map((account) => {
      const option = document.createElement('option');
      option.value = account.id;
      option.textContent = account.name;
      return option;
    })
  );
  $('install-simple').disabled = !data.accounts.length;
  $('preview').disabled = !data.accounts.length;
  if (fullInstaller && !ready) loadZones().catch((error) => message(error.message));
  if (!data.accounts.length)
    message(
      'No authorized accounts were found. Disconnect and try again with an account you can manage.'
    );
  if (data.job) $('worker-name').textContent = data.job.name;
  if (data.job?.status === 'pending')
    message(`Setup was interrupted. Retry to resume the same Worker: ${data.job.name}`);
}
async function createInstallation(fingerprint) {
  message(
    'Creating your installation service. Keep this page open; retrying will resume the same service if interrupted.'
  );
  await api('install', {
    accountId: $('account-id').value,
    confirmed: true,
    fingerprint,
  });
  render(await api('status'));
  message('Your installation service is ready.', 'success');
}
$('install-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (busy || fullInstaller) return;
  if (!$('confirm').checked) return;
  busy = true;
  $('install-simple').disabled = true;
  try {
    await createInstallation();
  } catch (error) {
    if (error.message !== 'session-expired') message(error.message);
  } finally {
    busy = false;
    $('install-simple').disabled = false;
  }
});
$('review-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (busy || !approvedPlan) return;
  if (!$('confirm-full').checked) return;
  busy = true;
  $('install').disabled = true;
  try {
    await createInstallation(approvedPlan.fingerprint);
  } catch (error) {
    if (error.message !== 'session-expired') message(error.message);
  } finally {
    busy = false;
    $('install').disabled = false;
  }
});
$('account-id').addEventListener('change', () => {
  if (fullInstaller) loadZones().catch((error) => message(error.message));
});
['zone-id', 'base-domain', 'owner-email'].forEach((id) =>
  $(id).addEventListener('input', () => {
    if (id === 'base-domain') $('base-domain-shown').textContent = $('base-domain').value;
    invalidatePlan();
  })
);
function conflictGroups(plan) {
  const kind = (record) =>
    record.type === 'certificate' ? 'certificate' : record.type === 'route' ? 'route' : 'dns';
  const names = (group) =>
    plan.conflicts.filter((record) => kind(record) === group).map((record) => record.name).join(', ');
  return names;
}
function renderPlanSummary(plan) {
  const summary = $('plan-summary');
  summary.dataset.tone = plan.conflicts.length ? 'warning' : 'success';
  summary.setAttribute('role', plan.conflicts.length ? 'alert' : 'status');
  if (plan.conflicts.length) {
    const names = conflictGroups(plan);
    const parts = [];
    if (names('dns'))
      parts.push(
        `Existing DNS records block installation: ${names('dns')}. Remove them in Cloudflare or choose another domain.`
      );
    if (names('route'))
      parts.push(
        `Existing Workers routes block installation: ${names('route')}. Remove them in Cloudflare (your domain, Workers Routes) or choose another domain.`
      );
    if (names('certificate'))
      parts.push(
        `No active Cloudflare certificate covers ${names('certificate')}. Install directly at ${plan.zoneName}, which Cloudflare's free certificate covers, or add an Advanced Certificate for these names.`
      );
    summary.textContent = parts.join(' ');
    $('review-blocked').hidden = false;
    $('review-form').hidden = true;
  } else {
    const title = document.createElement('h3');
    title.textContent = 'Your installation plan';
    const list = document.createElement('dl');
    list.className = 'plan-list';
    const row = (label, value) => {
      const group = document.createElement('div');
      const term = document.createElement('dt');
      term.textContent = label;
      const detail = document.createElement('dd');
      if (typeof value === 'string') detail.textContent = value;
      else detail.append(value);
      group.append(term, detail);
      list.append(group);
    };
    const hosts = document.createElement('ul');
    plan.hostnames.forEach((host) => {
      const li = document.createElement('li');
      li.textContent = host;
      hosts.append(li);
    });
    row('Hostnames', hosts);
    row(
      'Account address',
      `${plan.workersDev.action === 'create' ? 'Initialize account address' : 'Preserve account address'} ${plan.workersDev.subdomain}.workers.dev`
    );
    const source = document.createElement('a');
    source.textContent = plan.sourceCommit.slice(0, 8);
    if (/^[a-f0-9]{40}$/.test(plan.sourceCommit))
      source.href = `https://github.com/raphaeltm/simple-agent-manager/commit/${plan.sourceCommit}`;
    row('Build source', source);
    summary.replaceChildren(title, list);
    const details = document.createElement('details');
    const more = document.createElement('summary');
    more.textContent = 'Cost and more details';
    details.append(more);
    const cost = document.createElement('p');
    cost.textContent = 'Cloudflare Workers Paid and usage charges apply. Your build runs in your account.';
    details.append(cost);
    summary.append(details);
    approvedPlan = plan;
    $('review-blocked').hidden = true;
    $('review-form').hidden = false;
  }
}
async function runPreview() {
  if (busy) return;
  busy = true;
  invalidatePlan();
  const revision = formRevision;
  const previousLabel = $('preview').textContent;
  $('preview').disabled = true;
  $('preview').textContent = 'Checking your installation…';
  try {
    const { plan } = await api('preview', {
      accountId: $('account-id').value,
      zoneId: $('zone-id').value,
      zoneName: $('zone-id').selectedOptions[0]?.textContent,
      baseDomain: $('base-domain').value.trim().toLowerCase(),
      ownerEmail: $('owner-email').value.trim(),
    });
    if (revision !== formRevision) return;
    renderPlanSummary(plan);
    screen('review');
    progress(stepIndex('review'));
  } catch (error) {
    if (error.message !== 'session-expired') message(error.message);
  } finally {
    busy = false;
    $('preview').disabled = false;
    $('preview').textContent = previousLabel;
  }
}
$('preview').addEventListener('click', runPreview);
$('check-again').addEventListener('click', runPreview);
$('back-to-choose').addEventListener('click', () => {
  screen('choose');
  progress(stepIndex('choose'));
});
$('disconnect').addEventListener('click', async () => {
  if (busy) return;
  try {
    const result = await api('finish', {});
    returnToConnect(
      result.revoked
        ? 'Session cleared. Created Workers remain in your Cloudflare account.'
        : 'Session cleared locally. Revoke the installer in Cloudflare’s authorized applications to confirm access is removed.'
    );
  } catch (error) {
    if (error.message !== 'session-expired') message(error.message);
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
    if (error.message !== 'session-expired') message(error.message);
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
    $('choose-simple-actions').hidden = fullInstaller;
    progress(0);
    if (fullInstaller) {
      $('full-permissions').hidden = false;
      $('installer-mode-note').textContent =
        'Experimental full installation: your maintenance service builds and deploys the approved SAM source in your account. Review the domain, permissions and usage charges before continuing.';
      ['zone-id', 'base-domain', 'owner-email'].forEach((id) => ($(id).required = true));
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
    if (response.status === 401) {
      rememberCleanup(data);
      if (data.cleanupReceipt) message(data.error);
      return;
    }
    rememberCleanup(data);
    if (response.ok) render(data);
    else message(data.error);
  } catch {
    message('The installer could not load. Please refresh to try again.');
  }
})();
