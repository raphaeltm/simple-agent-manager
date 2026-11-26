import { checkedOutCommit } from './git-head.mjs';
import {
  createApi,
  delayFromEnv,
  intFromEnv,
  probeTimeoutMs,
  readTarget,
  SECRET_NAMES,
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
const bindings = Array.isArray(settings?.bindings) ? settings.bindings : [];
const deployed = (variable) =>
  bindings.find((binding) => binding.name === variable && binding.type === 'plain_text')?.text;
const origin = deployed('APP_ORIGIN');
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
// The zone's bot protection can answer a non-browser client, such as a CI runner, with a
// challenge instead of the installer (SAM's own domains since 2026-11-24). The public pages
// cannot be checked from such a client, so what the Cloudflare API reports for the deployed
// Worker is checked instead: the commit it runs, full mode, its OAuth secrets, and that the
// address leads to it. That does not exercise sign-in, and the message says so. An installer that is not challenged, such
// as one on workers.dev, always gets the full check.
async function verifyThroughApi() {
  const state = `BUILD_SHA=${deployed('BUILD_SHA')} INSTALL_SOURCE_COMMIT=${deployed('INSTALL_SOURCE_COMMIT')}`;
  const secrets = SECRET_NAMES.every((secret) =>
    bindings.some((binding) => binding.name === secret && binding.type === 'secret_text')
  );
  if (
    deployed('BUILD_SHA') !== expected ||
    deployed('INSTALL_SOURCE_COMMIT') !== expected ||
    !secrets
  )
    throw new Error(
      `Installer ${name} is not the expected deployment; expected=${expected} ${state} oauthSecrets=${secrets} (Cloudflare API; the public address answers this client with a challenge)`
    );
  // A challenge is answered before the request reaches any Worker, so it says nothing about
  // which Worker the address leads to. That is read from the API too.
  const host = new URL(origin).hostname;
  let routing;
  if (host.endsWith('.workers.dev')) {
    const subdomain = await api(`${worker}/subdomain`);
    if (subdomain?.enabled !== true)
      throw new Error(`Installer ${name} is not enabled on workers.dev (Cloudflare API).`);
    routing = 'its workers.dev address is enabled';
  } else {
    const zoneName = host.replace(/^install\./, '');
    const domains = await api(`${base}/workers/domains?zone_name=${encodeURIComponent(zoneName)}`);
    const customDomain =
      Array.isArray(domains) &&
      domains.some((domain) => domain.hostname === host && domain.service === name);
    const zones = await api(`/zones?name=${encodeURIComponent(zoneName)}`);
    const zoneId = Array.isArray(zones) ? zones.find((zone) => zone.name === zoneName)?.id : '';
    const routes = zoneId ? await api(`/zones/${zoneId}/workers/routes`) : [];
    const route =
      Array.isArray(routes) &&
      routes.some((entry) => entry.pattern === `${host}/*` && entry.script === name);
    if (!customDomain || !route)
      throw new Error(
        `${host} does not lead to installer ${name}; customDomain=${customDomain} route=${route} (Cloudflare API)`
      );
    routing = 'its custom domain and route lead to this Worker';
  }
  console.log(
    `Installer at ${origin}: Cloudflare answers this client with a challenge, so its public pages were not checked. Through the Cloudflare API: commit ${expected}, full mode, OAuth secrets present, ${routing}. Sign-in was not exercised.`
  );
}
// A freshly written Worker secret or version can take a few seconds to reach every edge.
const CLOUDFLARE_DASHBOARD = 'https://dash.cloudflare.com';
const deadline = Date.now() + intFromEnv('INSTALLER_READY_TIMEOUT_MS', 90000);
const pollMs = delayFromEnv('INSTALLER_READY_POLL_MS', 3000);
let last = 'no response';
let challenged = false;
for (;;) {
  try {
    const answer = await read('/health');
    // Recorded before parsing, so an edge error page is reported by status and type.
    last = `status=${answer.status} type=${answer.headers.get('content-type')} cf-ray=${answer.headers.get('cf-ray')}`;
    if (answer.headers.get('cf-mitigated') === 'challenge') {
      challenged = true;
      break;
    }
    const health = JSON.parse(await answer.text());
    const config = await (await read('/api/config')).json();
    last = `expected=${expected} sha=${health.sha} oauthConfigured=${health.oauthConfigured} fullInstaller=${config.fullInstaller}`;
    if (health.sha === expected && health.oauthConfigured === true && config.fullInstaller === true)
      break;
  } catch (error) {
    last += ` (${error instanceof Error ? error.name : 'unknown'})`;
  }
  if (Date.now() >= deadline) throw new Error(`Installer at ${origin} is not ready; ${last}`);
  await sleepWithin(deadline, pollMs);
}
async function checkSignIn() {
  // The health answer above came from one edge location. A just-written OAuth secret can
  // still be missing at another, where sign-in answers 503 "not configured yet", so that one
  // status is retried inside the same deadline. Anything else is judged at once.
  let start;
  for (;;) {
    start = await read('/oauth/start', { method: 'POST', headers: { Origin: origin } });
    if (start.status !== 503 || Date.now() >= deadline) break;
    await sleepWithin(deadline, pollMs);
  }
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
}
if (challenged) await verifyThroughApi();
else await checkSignIn();
