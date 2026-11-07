import { api } from './installer/api.js';
import { forgetCleanup, rememberCleanup, renderCleanup, restoreSavedCleanup } from './installer/cleanup.js';
import { invalidatePlan, loadZones, runPreview } from './installer/plan.js';
import { message, progress, returnToConnect, screen, stepIndex } from './installer/screens.js';
import { $, state } from './installer/state.js';

restoreSavedCleanup();

function render(data) {
  state.authorizedAccounts = data.accounts;
  state.currentCleanupReceipt = data.currentCleanupReceipt;
  rememberCleanup(data);
  if (data.job?.status === 'ready' && state.cleanupReceipt?.receipt === state.currentCleanupReceipt)
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
  $('install-simple').disabled = !data.accounts.length || !$('confirm').checked;
  $('preview').disabled = !data.accounts.length;
  if (state.fullInstaller && !ready) loadZones().catch((error) => message(error.message, 'error'));
  if (!data.accounts.length)
    message(
      'No authorized accounts were found. Disconnect and try again with an account you can manage.'
    );
  if (data.job) $('worker-name').textContent = data.job.name;
  if (data.job?.status === 'pending') {
    $('install-simple').textContent = 'Resume my installation service';
    message(`Setup was interrupted. Retry to resume the same Worker: ${data.job.name}`);
  }
}

const CREATING_LABEL = 'Creating your installation service…';
async function createInstallation(buttonId, fingerprint) {
  const button = $(buttonId);
  const previousLabel = button.textContent;
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  button.textContent = CREATING_LABEL;
  message(
    'Creating your installation service. Keep this page open; retrying will resume the same service if interrupted.'
  );
  try {
    await api('install', {
      accountId: $('account-id').value,
      confirmed: true,
      fingerprint,
    });
    render(await api('status'));
    message('Your installation service is ready.', 'success');
  } finally {
    button.removeAttribute('aria-busy');
    // render() may have already set a more specific label (e.g. "Resume my
    // installation service" for a pending job); only restore the pre-busy
    // label if nothing else claimed the button in the meantime.
    if (button.textContent === CREATING_LABEL) button.textContent = previousLabel;
  }
}

$('install-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (state.busy || state.fullInstaller || !$('confirm').checked) return;
  state.busy = true;
  try {
    await createInstallation('install-simple');
  } catch (error) {
    if (error.message !== 'session-expired') message(error.message, 'error');
  } finally {
    state.busy = false;
    $('install-simple').disabled = !$('confirm').checked;
  }
});
$('confirm').addEventListener('change', () => {
  $('install-simple').disabled = !$('confirm').checked || !state.authorizedAccounts.length;
});

$('review-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (state.busy || !state.approvedPlan || !$('confirm-full').checked) return;
  state.busy = true;
  try {
    await createInstallation('install', state.approvedPlan.fingerprint);
  } catch (error) {
    if (error.message !== 'session-expired') message(error.message, 'error');
  } finally {
    state.busy = false;
    $('install').disabled = !$('confirm-full').checked;
  }
});
$('confirm-full').addEventListener('change', () => {
  $('install').disabled = !$('confirm-full').checked;
});

$('account-id').addEventListener('change', () => {
  if (state.fullInstaller) loadZones().catch((error) => message(error.message, 'error'));
});
['zone-id', 'base-domain', 'owner-email'].forEach((id) =>
  $(id).addEventListener('input', () => {
    if (id === 'base-domain') $('base-domain-shown').textContent = $('base-domain').value;
    invalidatePlan();
  })
);
$('preview').addEventListener('click', runPreview);
$('check-again').addEventListener('click', runPreview);
$('use-different-domain').addEventListener('click', () => {
  screen('choose');
  progress(stepIndex('choose'));
  $('zone-id').focus();
});
$('back-to-choose').addEventListener('click', () => {
  screen('choose');
  progress(stepIndex('choose'));
});
$('disconnect').addEventListener('click', async () => {
  if (state.busy) return;
  try {
    const result = await api('finish', {});
    forgetCleanup();
    returnToConnect(
      result.revoked
        ? 'Session cleared. Created Workers remain in your Cloudflare account.'
        : 'Session cleared locally. Revoke the installer in Cloudflare’s authorized applications to confirm access is removed.'
    );
  } catch (error) {
    if (error.message !== 'session-expired') message(error.message, 'error');
  }
});
$('cleanup-resume').addEventListener('click', async () => {
  if (state.busy || !state.cleanupReceipt) return;
  state.busy = true;
  $('cleanup-resume').disabled = true;
  try {
    const result = await api('reconcile-cleanup', state.cleanupReceipt);
    forgetCleanup();
    message(
      result.authorityPreserved
        ? 'Cleanup confirmed. Credentials owned by your installation service were preserved.'
        : 'Unused setup credentials removed. You can continue with a fresh setup.',
      'success'
    );
  } catch (error) {
    if (error.message !== 'session-expired') message(error.message, 'error');
  } finally {
    state.busy = false;
    $('cleanup-resume').disabled = false;
  }
});
void (async () => {
  try {
    const config = await (await fetch('/api/config')).json();
    state.fullInstaller = config.fullInstaller === true;
    $('deployment-settings').hidden = !state.fullInstaller;
    $('choose-simple-actions').hidden = state.fullInstaller;
    progress(0);
    if (state.fullInstaller) {
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
        'Cloudflare authorization was cancelled or could not be completed. Sign in again to continue.',
        'error'
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
    else message(data.error, 'error');
  } catch {
    message('The installer could not load. Please refresh to try again.', 'error');
  }
})();
