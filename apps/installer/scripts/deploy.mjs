import { spawnSync } from 'node:child_process';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { ApiFailure, createApi, readTarget, SECRET_NAMES, wrangler } from './installer-target.mjs';

// Verified against Cloudflare GET /oauth/scopes on 2026-10-28; the email scopes on
// 2026-11-08 (email sign-in codes and agent email); the Artifacts scopes on
// 2026-11-09; cloudflared Write on 2026-11-10. Validate the live
// catalog before every registration/scope change; these are OAuth scope IDs,
// not account-token permission-group display names.
const TUNNEL_SCOPE = 'teams-connector-cloudflared.write';
const FULL_SCOPES = [
  'account-settings.read',
  'account-api-tokens.write',
  'workers-scripts.write',
  'workers-scripts.read',
  'workers-kv-storage.write',
  'workers-r2.write',
  'containers.write',
  'd1.write',
  'page.write',
  'workers-routes.write',
  'dns.write',
  'zone.read',
  'ssl-and-certificates.write',
  'ai.read',
  'ai.write',
  'aig.read',
  'aig.run',
  'aig.write',
  'workers-observability.read',
  'zone-settings.write',
  'email-routing-rule.write',
  'email-sending.write',
  // SAM-hosted repositories on Cloudflare Artifacts (optional token groups in credentials.ts).
  'artifacts.read',
  'artifacts.write',
  TUNNEL_SCOPE,
];
// Installations build SAM from this repository (src/source-policy.ts), so the pinned
// commit must exist there, and its releases carry the prebuilt artifacts.
const UPSTREAM_REPOSITORY = 'raphaeltm/simple-agent-manager';
const DEFAULT_ARTIFACT_BASE_URL = `https://github.com/${UPSTREAM_REPOSITORY}/releases/latest/download`;
process.chdir(fileURLToPath(new URL('..', import.meta.url)));
const { token, account, name, base, worker } = readTarget();
const domain = process.env.BASE_DOMAIN || '';
const mode = process.env.INSTALLER_MODE || 'preserve';
if (domain && !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(domain))
  throw new Error('BASE_DOMAIN is not a valid domain.');
if (!['preserve', 'bootstrap', 'full'].includes(mode)) throw new Error('Invalid installer mode');
const api = createApi({ token, base, registrationToken: process.env.OAUTH_REGISTRATION_TOKEN });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const template = JSON.parse(await readFile('wrangler.json', 'utf8'));
let existing;
try {
  existing = await api(`${worker}/settings`);
} catch (error) {
  if (!(error instanceof ApiFailure) || error.status !== 404) throw error;
}
const bindings = Array.isArray(existing?.bindings) ? existing.bindings : [];
const currentVars = Object.fromEntries(
  bindings
    .filter(
      (binding) =>
        binding.type === 'plain_text' &&
        typeof binding.text === 'string' &&
        ![...SECRET_NAMES, 'OAUTH_REGISTRATION_TOKEN'].includes(binding.name)
    )
    .map((binding) => [binding.name, binding.text])
);
const existingSecrets = bindings
  .filter((binding) => binding.type === 'secret_text')
  .map((binding) => binding.name);
const ready = SECRET_NAMES.every((key) => existingSecrets.includes(key));
// A fresh installer installs SAM. An existing one keeps its mode unless told otherwise.
const full =
  mode === 'full' ||
  (mode === 'preserve' && (existing ? !!currentVars.INSTALL_SOURCE_COMMIT : true));
const sameScopes = (left, right) =>
  JSON.stringify([...new Set(left)].sort((a, b) => a.localeCompare(b))) ===
  JSON.stringify([...new Set(right)].sort((a, b) => a.localeCompare(b)));
const deployedScopes = (currentVars.OAUTH_SCOPES || '').split(/\s+/).filter(Boolean);
// Bootstrap consent sets that can never create the maintenance Worker:
// workers-scripts.edit is Cloudflare's "Workers Editor" role, which cannot
// create Workers. Preserving one would keep every bootstrap install failing
// with 403, so a preserved deployment that still requests it is upgraded to
// the current bootstrap template.
const SUPERSEDED_BOOTSTRAP_SCOPES = [['account-settings.read', 'workers-scripts.edit']];
const supersededBootstrap =
  !full && SUPERSEDED_BOOTSTRAP_SCOPES.some((set) => sameScopes(set, deployedScopes));
// A full installer now creates runtime credentials with cloudflared Write.
// Reconcile that consent before repinning its source; preserve other operator
// scopes and leave the minimal bootstrap installer unchanged.
const preservedScopes = full ? [...new Set([...deployedScopes, TUNNEL_SCOPE])] : deployedScopes;
const scopes =
  mode === 'preserve' && deployedScopes.length && !supersededBootstrap
    ? preservedScopes
    : full
      ? FULL_SCOPES
      : template.vars.OAUTH_SCOPES.split(/\s+/);
const scopesChanged = !sameScopes(scopes, deployedScopes);
// With BASE_DOMAIN the installer is served at install.<domain>. Without it, an existing
// installer keeps its address and a new one uses the account's workers.dev address, which
// needs no zone permissions and leaves no DNS record or route behind.
async function resolveOrigin() {
  if (domain) return `https://install.${domain}`;
  if (existing && /^https:\/\/[a-z0-9.-]+$/.test(currentVars.APP_ORIGIN || ''))
    return currentVars.APP_ORIGIN;
  let subdomain;
  try {
    subdomain = (await api(`${base}/workers/subdomain`))?.subdomain;
  } catch (error) {
    if (!(error instanceof ApiFailure) || error.status !== 404) throw error;
  }
  if (typeof subdomain !== 'string' || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(subdomain))
    throw new Error(
      'This account has no workers.dev address yet. Open Workers & Pages in the Cloudflare dashboard once to create it, or set BASE_DOMAIN to serve the installer at install.<your domain>.'
    );
  return `https://${name}.${subdomain}.workers.dev`;
}
const origin = await resolveOrigin();
const host = new URL(origin).hostname;
const workersDev = host.endsWith('.workers.dev');
if (!workersDev && !host.startsWith('install.'))
  throw new Error('The deployed installer address is not supported; set BASE_DOMAIN.');
const zone = host.slice('install.'.length);
function checkedOutCommit() {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });
  return result.status === 0 ? String(result.stdout || '').trim() : '';
}
const revision = process.env.GITHUB_SHA || checkedOutCommit();
// The installation service builds exactly this commit from the upstream repository.
async function resolveSourceCommit() {
  if (!revision)
    throw new Error(
      'Could not read the checked-out commit. Run this from a git checkout of SAM, or set GITHUB_SHA to the commit to install.'
    );
  if (!/^[a-f0-9]{40}$/.test(revision))
    throw new Error('Full installer mode requires the exact immutable GITHUB_SHA');
  let response;
  try {
    response = await fetch(
      `https://raw.githubusercontent.com/${UPSTREAM_REPOSITORY}/${revision}/scripts/deploy/installer-protocol.json`,
      { method: 'HEAD', signal: AbortSignal.timeout(15_000) }
    );
  } catch {
    throw new Error(`Could not check commit ${revision} against ${UPSTREAM_REPOSITORY}. Retry.`);
  }
  if (response.status === 404)
    throw new Error(
      `Commit ${revision} is not in ${UPSTREAM_REPOSITORY}. Installations build SAM from that repository, so check out a released version (git checkout <release tag>) and run again.`
    );
  if (!response.ok)
    throw new Error(
      `Could not check commit ${revision} against ${UPSTREAM_REPOSITORY} (${response.status}). Retry.`
    );
  return revision;
}
const sourceCommit = full ? await resolveSourceCommit() : undefined;
const config = {
  ...template,
  name,
  account_id: account,
  workers_dev: workersDev,
  preview_urls: false,
  ...(workersDev
    ? {}
    : {
        routes: [
          { pattern: `install.${zone}`, custom_domain: true },
          { pattern: `install.${zone}/*`, zone_name: zone },
        ],
      }),
  vars: {
    ...template.vars,
    ...currentVars,
    APP_ORIGIN: origin,
    BUILD_SHA: revision || 'self-hosted',
    OAUTH_SCOPES: scopes.join(' '),
  },
};
if (sourceCommit) config.vars.INSTALL_SOURCE_COMMIT = sourceCommit;
else delete config.vars.INSTALL_SOURCE_COMMIT;
config.vars.SOURCE_URL =
  process.env.SOURCE_URL ||
  template.vars.SOURCE_URL.replace(
    '/tree/main/',
    /^[a-f0-9]{40}$/.test(revision) ? `/tree/${revision}/` : '/tree/main/'
  );
config.vars.DOCS_URL = process.env.DOCS_URL || template.vars.DOCS_URL;
// Prebuilt installation artifacts. An explicit URL wins, then whatever the deployed
// installer already has, then SAM's latest release. "none" always builds from source.
// Anything missing or mismatched at that URL is built instead (installer-engine-prebuilt.ts).
const artifactBaseUrl = process.env.ARTIFACT_BASE_URL;
if (artifactBaseUrl === 'none') delete config.vars.ARTIFACT_BASE_URL;
else if (artifactBaseUrl) {
  if (!/^https:\/\/[^\s?#@]{1,500}$/.test(artifactBaseUrl))
    throw new Error(
      'ARTIFACT_BASE_URL must be an https URL without credentials, query or fragment'
    );
  config.vars.ARTIFACT_BASE_URL = artifactBaseUrl;
} else if (!config.vars.ARTIFACT_BASE_URL)
  config.vars.ARTIFACT_BASE_URL = DEFAULT_ARTIFACT_BASE_URL;
const explicitCredentials = !!(process.env.OAUTH_CLIENT_ID || process.env.OAUTH_CLIENT_SECRET);
const reuseReadyConfiguration = !!existing && ready && !scopesChanged && !explicitCredentials;
async function findOAuthClient(clientId) {
  let client;
  if (clientId) client = await api(`${base}/oauth_clients/${encodeURIComponent(clientId)}`);
  else {
    const clients = await api(`${base}/oauth_clients`);
    if (!Array.isArray(clients)) throw new Error('Invalid OAuth client list');
    const matches = clients.filter(
      (candidate) => candidate.client_name === name && candidate.client_uri === origin
    );
    if (matches.length > 1)
      throw new Error('Multiple matching OAuth clients require operator repair');
    client = matches[0];
    clientId = client?.client_id;
    if (clientId) client = await api(`${base}/oauth_clients/${encodeURIComponent(clientId)}`);
  }
  return client;
}
function matchesOAuthClient(client, desired) {
  return (
    sameScopes(client.scopes || [], desired.scopes) &&
    ['token_endpoint_auth_method', 'redirect_uris', 'grant_types', 'response_types'].every(
      (key) => JSON.stringify(client[key]) === JSON.stringify(desired[key])
    )
  );
}
// Cloudflare rejected client creation (observed 2026-11-08 in production: POST
// /oauth_clients returned 500) while the client's logo and policy URLs on the
// installer origin were not served yet. When no installer Worker exists, the
// preflight therefore only validates the catalog and management access, and any
// client mutation (create, or update of a leftover client) waits until the
// Worker and its assets are live. A write failure after publishing then leaves a
// fresh Worker without OAuth secrets; the run fails, health never reports
// oauthConfigured, and the next run reconciles the client.
async function prepareOAuth({ deferMutation = false } = {}) {
  const catalog = await api('/oauth/scopes');
  if (
    !Array.isArray(catalog) ||
    scopes.some((scope) => !catalog.some((entry) => entry.id === scope))
  )
    throw new Error('Requested OAuth scopes are not in the current Cloudflare catalog');
  let clientId = process.env.OAUTH_CLIENT_ID,
    clientSecret = process.env.OAUTH_CLIENT_SECRET;
  let client = await findOAuthClient(clientId);
  clientId = client?.client_id ?? clientId;
  const desired = {
    client_name: name,
    client_uri: origin,
    logo_uri: `${origin}/sam-head.png`,
    policy_uri: `${origin}/privacy.html`,
    tos_uri: `${origin}/privacy.html`,
    grant_types: ['authorization_code'],
    response_types: ['code'],
    redirect_uris: [`${origin}/oauth/callback`],
    scopes,
    token_endpoint_auth_method: 'client_secret_post',
  };
  if (deferMutation && (!client || !matchesOAuthClient(client, desired))) return undefined;
  if (!client) {
    client = await api(`${base}/oauth_clients`, 'POST', desired);
    clientId = client.client_id;
    clientSecret = client.client_secret;
    if (typeof clientSecret !== 'string' || !clientSecret)
      throw new Error('Cloudflare did not return a private client secret');
  } else {
    if (client.client_uri !== origin || client.client_name !== name)
      throw new Error('OAuth client does not belong to this installer origin');
    const matches = matchesOAuthClient(client, desired);
    if (!matches) {
      await api(`${base}/oauth_clients/${encodeURIComponent(clientId)}`, 'PATCH', desired);
      client = await api(`${base}/oauth_clients/${encodeURIComponent(clientId)}`);
    }
  }
  if (!clientId || !matchesOAuthClient(client, desired))
    throw new Error('OAuth client scope/callback configuration was not confirmed');
  if (!clientSecret && !ready)
    throw new Error(
      'OAuth secret missing. Supply the existing private client secret or rotate it in Cloudflare.'
    );
  if (process.env.OAUTH_CLIENT_ID && !clientSecret)
    throw new Error('An explicit OAuth client override also requires its private secret');
  return { OAUTH_CLIENT_ID: clientId, OAUTH_CLIENT_SECRET: clientSecret };
}
// Full enablement and requested scope changes on an existing service must pass
// OAuth management preflight before publishing a Worker that requests them.
// A fresh bootstrap still ships approved static assets before OAuth readiness.
const preflight = !reuseReadyConfiguration && (full || (!!existing && scopesChanged));
let credentials;
if (preflight) credentials = await prepareOAuth({ deferMutation: !existing });
// Cloudflare fetches the client's logo and policy URLs when a client is created, and a
// first publish can take a moment to answer. Best effort: registration reports its own failure.
async function waitUntilServed() {
  const deadline = Date.now() + Number(process.env.INSTALLER_LIVE_TIMEOUT_MS || 60000);
  for (;;) {
    try {
      const response = await fetch(`${origin}/health`, {
        cache: 'no-store',
        signal: AbortSignal.timeout(5000),
      });
      if (response.ok) return;
    } catch {
      // Not answering yet.
    }
    if (Date.now() >= deadline) return;
    await sleep(Number(process.env.INSTALLER_LIVE_POLL_MS || 2000));
  }
}
const generated = '.wrangler-deploy.json';
await writeFile(generated, JSON.stringify(config, null, 2), { mode: 0o600 });
try {
  wrangler(['deploy', '--config', generated]);
  if (!reuseReadyConfiguration) {
    if (!credentials) await waitUntilServed();
    credentials ||= await prepareOAuth();
    for (const [key, value] of Object.entries(credentials))
      if (value)
        await api(`${worker}/secrets`, 'PUT', { name: key, text: value, type: 'secret_text' });
  }
  // The secrets list can lag a just-published version or secret write by a
  // few seconds (observed 2026-11-06), so poll briefly before failing.
  const visibleBy = Date.now() + Number(process.env.OAUTH_SECRETS_VISIBLE_TIMEOUT_MS || 30000);
  for (;;) {
    const secrets = await api(`${worker}/secrets`);
    if (SECRET_NAMES.every((key) => secrets.some((entry) => entry.name === key))) break;
    if (Date.now() >= visibleBy)
      throw new Error('OAuth secret missing after deployment; readiness was not established');
    await sleep(Number(process.env.OAUTH_SECRETS_POLL_MS || 2000));
  }
  console.log(`Installer ready: ${origin}`);
  console.log(
    full
      ? 'Open that address and select "Sign in with Cloudflare" to install SAM in this account.'
      : 'This installer is in bootstrap mode and cannot install SAM. Run again with INSTALLER_MODE=full.'
  );
  console.log(
    'Once your installation service is set up, you can remove the installer: pnpm --filter @simple-agent-manager/installer run remove'
  );
} finally {
  await unlink(generated).catch(() => {});
}
