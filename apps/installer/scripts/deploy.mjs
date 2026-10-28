import { spawnSync } from 'node:child_process';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Verified against Cloudflare GET /oauth/scopes on 2026-10-28. Validate the live
// catalog before every registration/scope change; these are OAuth scope IDs,
// not account-token permission-group display names.
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
];
const SECRET_NAMES = ['OAUTH_CLIENT_ID', 'OAUTH_CLIENT_SECRET'];
process.chdir(fileURLToPath(new URL('..', import.meta.url)));
const token = process.env.CLOUDFLARE_API_TOKEN;
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const domain = process.env.BASE_DOMAIN;
const environment = process.env.INSTALLER_ENVIRONMENT || 'self-hosted';
const mode = process.env.INSTALLER_MODE || 'preserve';
if (
  !token ||
  !/^[a-f0-9]{32}$/.test(account || '') ||
  !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(domain || '')
)
  throw new Error('Set deployment token, account ID and a valid BASE_DOMAIN.');
if (!/^[a-z0-9-]+$/.test(environment) || !['preserve', 'bootstrap', 'full'].includes(mode))
  throw new Error('Invalid installer environment or mode');
const name = `sam-installer-${environment}`,
  origin = `https://install.${domain}`;
const base = `/accounts/${account}`,
  worker = `${base}/workers/scripts/${name}`;
class ApiFailure extends Error {
  constructor(status, method) {
    super(
      `Cloudflare ${method} failed (${status}). Verify the required API permissions. Private response omitted.`
    );
    this.status = status;
  }
}
async function api(path, method = 'GET', body) {
  const oauthApi = path === '/oauth/scopes' || path.startsWith(`${base}/oauth_clients`);
  const authorization = oauthApi ? process.env.OAUTH_REGISTRATION_TOKEN || token : token;
  let response, data;
  try {
    response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
      method,
      headers: { Authorization: `Bearer ${authorization}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    data = await response.json();
  } catch {
    throw new Error('Cloudflare request could not complete. Private response omitted.');
  }
  if (!response.ok || data.success === false) throw new ApiFailure(response.status, method);
  return data.result;
}
function wrangler(args) {
  const childEnvironment = { ...process.env };
  for (const key of ['OAUTH_REGISTRATION_TOKEN', ...SECRET_NAMES]) delete childEnvironment[key];
  const result = spawnSync('pnpm', ['exec', 'wrangler', ...args], {
    stdio: 'inherit',
    env: childEnvironment,
  });
  if (result.status !== 0) throw new Error('Wrangler deployment failed');
}
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
const full = mode === 'full' || (mode === 'preserve' && !!currentVars.INSTALL_SOURCE_COMMIT);
const scopes =
  mode === 'preserve' && currentVars.OAUTH_SCOPES
    ? currentVars.OAUTH_SCOPES.split(/\s+/).filter(Boolean)
    : full
      ? FULL_SCOPES
      : template.vars.OAUTH_SCOPES.split(/\s+/);
const sameScopes = (left, right) =>
  JSON.stringify([...new Set(left)].sort()) === JSON.stringify([...new Set(right)].sort());
const scopesChanged = !sameScopes(
  scopes,
  (currentVars.OAUTH_SCOPES || '').split(/\s+/).filter(Boolean)
);
if (full && !/^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA || ''))
  throw new Error('Full installer mode requires the exact immutable GITHUB_SHA');
const config = {
  ...template,
  name,
  account_id: account,
  workers_dev: false,
  routes: [
    { pattern: `install.${domain}`, custom_domain: true },
    { pattern: `install.${domain}/*`, zone_name: domain },
  ],
  vars: {
    ...template.vars,
    ...currentVars,
    APP_ORIGIN: origin,
    BUILD_SHA: process.env.GITHUB_SHA || 'self-hosted',
    OAUTH_SCOPES: scopes.join(' '),
  },
};
if (full) config.vars.INSTALL_SOURCE_COMMIT = process.env.GITHUB_SHA;
else delete config.vars.INSTALL_SOURCE_COMMIT;
config.vars.SOURCE_URL =
  process.env.SOURCE_URL ||
  template.vars.SOURCE_URL.replace(
    '/tree/main/',
    /^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA || '')
      ? `/tree/${process.env.GITHUB_SHA}/`
      : '/tree/main/'
  );
config.vars.DOCS_URL = process.env.DOCS_URL || template.vars.DOCS_URL;
const explicitCredentials = !!(process.env.OAUTH_CLIENT_ID || process.env.OAUTH_CLIENT_SECRET);
const reuseReadyConfiguration = !!existing && ready && !scopesChanged && !explicitCredentials;
async function prepareOAuth() {
  const catalog = await api('/oauth/scopes');
  if (
    !Array.isArray(catalog) ||
    scopes.some((scope) => !catalog.some((entry) => entry.id === scope))
  )
    throw new Error('Requested OAuth scopes are not in the current Cloudflare catalog');
  let clientId = process.env.OAUTH_CLIENT_ID,
    clientSecret = process.env.OAUTH_CLIENT_SECRET;
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
  if (!client) {
    client = await api(`${base}/oauth_clients`, 'POST', desired);
    clientId = client.client_id;
    clientSecret = client.client_secret;
    if (typeof clientSecret !== 'string' || !clientSecret)
      throw new Error('Cloudflare did not return a private client secret');
  } else {
    if (client.client_uri !== origin || client.client_name !== name)
      throw new Error('OAuth client does not belong to this installer origin');
    const matches =
      sameScopes(client.scopes || [], scopes) &&
      client.token_endpoint_auth_method === desired.token_endpoint_auth_method &&
      JSON.stringify(client.redirect_uris) === JSON.stringify(desired.redirect_uris) &&
      JSON.stringify(client.grant_types) === JSON.stringify(desired.grant_types) &&
      JSON.stringify(client.response_types) === JSON.stringify(desired.response_types);
    if (!matches) {
      await api(`${base}/oauth_clients/${encodeURIComponent(clientId)}`, 'PATCH', desired);
      client = await api(`${base}/oauth_clients/${encodeURIComponent(clientId)}`);
    }
  }
  if (
    !clientId ||
    !sameScopes(client.scopes || [], scopes) ||
    client.token_endpoint_auth_method !== 'client_secret_post' ||
    JSON.stringify(client.redirect_uris) !== JSON.stringify(desired.redirect_uris) ||
    JSON.stringify(client.grant_types) !== JSON.stringify(desired.grant_types) ||
    JSON.stringify(client.response_types) !== JSON.stringify(desired.response_types)
  )
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
if (preflight) credentials = await prepareOAuth();
const generated = '.wrangler-deploy.json';
await writeFile(generated, JSON.stringify(config, null, 2), { mode: 0o600 });
try {
  wrangler(['deploy', '--config', generated]);
  if (!reuseReadyConfiguration) {
    credentials ||= await prepareOAuth();
    for (const [key, value] of Object.entries(credentials))
      if (value)
        await api(`${worker}/secrets`, 'PUT', { name: key, text: value, type: 'secret_text' });
  }
  const secrets = await api(`${worker}/secrets`);
  if (!SECRET_NAMES.every((key) => secrets.some((entry) => entry.name === key)))
    throw new Error('OAuth secret missing after deployment; readiness was not established');
  console.log(
    `Installer deployed: ${origin}. Mode: ${full ? 'full' : 'bootstrap'}. OAuth visibility was not promoted; public promotion remains a separate owner action.`
  );
} finally {
  await unlink(generated).catch(() => {});
}
