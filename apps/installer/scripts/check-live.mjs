import { checkedOutCommit } from './git-head.mjs';
import {
  createApi,
  delayFromEnv,
  intFromEnv,
  probeTimeoutMs,
  readTarget,
  sleepWithin,
} from './installer-target.mjs';

// Checks a deployed installer the way a visitor reaches it: it answers on its own
// address, runs the expected commit in full mode, and "Sign in with Cloudflare"
// redirects to Cloudflare with this installer's client and callback.
const { token, name, base, worker } = readTarget();
const api = createApi({ token, base });
const requestTimeoutMs = probeTimeoutMs();
const expected = process.env.GITHUB_SHA || checkedOutCommit();
if (!/^[a-f0-9]{40}$/.test(expected)) throw new Error('Could not read the expected commit.');
const settings = await api(`${worker}/settings`);
const origin = (Array.isArray(settings?.bindings) ? settings.bindings : []).find(
  (binding) => binding.name === 'APP_ORIGIN' && binding.type === 'plain_text'
)?.text;
if (typeof origin !== 'string' || !/^https:\/\/[a-z0-9.-]+$/.test(origin))
  throw new Error(`Installer ${name} has no deployed address.`);
async function read(path, init = {}) {
  return fetch(`${origin}${path}`, {
    cache: 'no-store',
    redirect: 'manual',
    signal: AbortSignal.timeout(requestTimeoutMs),
    ...init,
  });
}
// A freshly written Worker secret or version can take a few seconds to reach every edge.
const CLOUDFLARE_DASHBOARD = 'https://dash.cloudflare.com';
const deadline = Date.now() + intFromEnv('INSTALLER_READY_TIMEOUT_MS', 90000);
const pollMs = delayFromEnv('INSTALLER_READY_POLL_MS', 3000);
let last = 'no response';
for (;;) {
  try {
    const health = await (await read('/health')).json();
    const config = await (await read('/api/config')).json();
    last = `expected=${expected} sha=${health.sha} oauthConfigured=${health.oauthConfigured} fullInstaller=${config.fullInstaller}`;
    if (health.sha === expected && health.oauthConfigured === true && config.fullInstaller === true)
      break;
  } catch (error) {
    last = `request failed: ${error instanceof Error ? error.name : 'unknown'}`;
  }
  if (Date.now() >= deadline) throw new Error(`Installer at ${origin} is not ready; ${last}`);
  await sleepWithin(deadline, pollMs);
}
const start = await read('/oauth/start', { method: 'POST', headers: { Origin: origin } });
const location = start.headers.get('Location') || '';
let target;
try {
  target = new URL(location);
} catch {
  throw new Error(`Sign-in did not redirect to Cloudflare (status ${start.status}).`);
}
if (
  start.status !== 303 ||
  target.origin !== CLOUDFLARE_DASHBOARD ||
  !target.searchParams.get('client_id') ||
  target.searchParams.get('redirect_uri') !== `${origin}/oauth/callback`
)
  throw new Error('Sign-in redirect does not carry this installer’s client and callback.');
// Cloudflare validates the client and callback before it asks anyone to log in: a known
// client with a registered callback goes to the login page, anything else to an error page
// (observed 2026-11-23). This proves the registration without a signed-in person.
const authorize = await fetch(target, {
  redirect: 'manual',
  signal: AbortSignal.timeout(requestTimeoutMs),
});
let next;
try {
  next = new URL(authorize.headers.get('Location') || '');
} catch {
  throw new Error(`Cloudflare did not answer the sign-in request (status ${authorize.status}).`);
}
if (next.origin !== CLOUDFLARE_DASHBOARD || next.pathname !== '/login') {
  const refusal = next.searchParams.get('error');
  throw new Error(
    refusal
      ? `Cloudflare did not accept this installer’s sign-in request (${refusal}).`
      : `Cloudflare sent the sign-in request to ${next.origin}${next.pathname} instead of its login page. If Cloudflare changed its sign-in flow, update check-live.mjs.`
  );
}
console.log(
  `Installer live at ${origin}: commit ${expected}, full mode, Cloudflare accepts its sign-in client and callback.`
);
