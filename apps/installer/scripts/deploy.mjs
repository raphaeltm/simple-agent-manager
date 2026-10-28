import { readFile, writeFile, unlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));
const token = process.env.CLOUDFLARE_API_TOKEN;
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const domain = process.env.BASE_DOMAIN;
const environment = process.env.INSTALLER_ENVIRONMENT || 'self-hosted';
if (
  !token ||
  !/^[a-f0-9]{32}$/.test(account || '') ||
  !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(domain || '')
)
  throw new Error('Set CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID and a valid BASE_DOMAIN.');
if (!/^[a-z0-9-]+$/.test(environment)) throw new Error('Invalid INSTALLER_ENVIRONMENT');
const name = `sam-installer-${environment}`;
const origin = `https://install.${domain}`;
async function api(path, method = 'GET', body) {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok || data.success === false)
    throw new Error(
      `Cloudflare ${method} ${path} failed (${response.status}; codes ${(data.errors || []).map((e) => e.code).join(',')}). Verify deployment token permissions. Response bodies omitted to protect credentials.`
    );
  return data.result;
}
function wrangler(args) {
  const result = spawnSync('pnpm', ['exec', 'wrangler', ...args], {
    stdio: 'inherit',
    env: process.env,
  });
  if (result.status !== 0) throw new Error('Wrangler deployment failed');
}
const config = JSON.parse(await readFile('wrangler.json', 'utf8'));
config.name = name;
config.account_id = account;
config.workers_dev = false;
// A hostname-specific route takes precedence over SAM's existing wildcard API route.
config.routes = [
  { pattern: `install.${domain}`, custom_domain: true },
  { pattern: `install.${domain}/*`, zone_name: domain },
];
config.vars.APP_ORIGIN = origin;
config.vars.BUILD_SHA = process.env.GITHUB_SHA || 'self-hosted';
if (process.env.SOURCE_URL) config.vars.SOURCE_URL = process.env.SOURCE_URL;
if (process.env.DOCS_URL) config.vars.DOCS_URL = process.env.DOCS_URL;
const generated = '.wrangler-deploy.json';
await writeFile(generated, JSON.stringify(config, null, 2));
try {
  wrangler(['deploy', '--config', generated]);
  const base = `/accounts/${account}`;
  let clientId = process.env.OAUTH_CLIENT_ID;
  let clientSecret = process.env.OAUTH_CLIENT_SECRET;
  if (!clientId) {
    const clients = await api(`${base}/oauth_clients`);
    const existing = clients.find((c) => c.client_name === name && c.client_uri === origin);
    if (existing) clientId = existing.client_id;
    else {
      const client = await api(`${base}/oauth_clients`, 'POST', {
        client_name: name,
        client_uri: origin,
        logo_uri: `${origin}/logo.svg`,
        policy_uri: `${origin}/privacy.html`,
        tos_uri: `${origin}/privacy.html`,
        grant_types: ['authorization_code'],
        response_types: ['code'],
        redirect_uris: [`${origin}/oauth/callback`],
        scopes: config.vars.OAUTH_SCOPES.split(' '),
        token_endpoint_auth_method: 'client_secret_post',
      });
      clientId = client.client_id;
      clientSecret = client.client_secret;
      if (!clientSecret) throw new Error('Cloudflare did not return a client secret');
    }
  }
  // Never emit credentials or serialize them to disk/CLI arguments.
  for (const [key, value] of Object.entries({
    OAUTH_CLIENT_ID: clientId,
    OAUTH_CLIENT_SECRET: clientSecret,
  })) {
    if (value)
      await api(`${base}/workers/scripts/${name}/secrets`, 'PUT', {
        name: key,
        text: value,
        type: 'secret_text',
      });
  }
  const secrets = await api(`${base}/workers/scripts/${name}/secrets`);
  if (
    !['OAUTH_CLIENT_ID', 'OAUTH_CLIENT_SECRET'].every((key) => secrets.some((s) => s.name === key))
  )
    throw new Error(
      'OAuth secret missing. Supply OAUTH_CLIENT_SECRET from your existing client or rotate it in Cloudflare.'
    );
  console.log(
    `Installer deployed: ${origin}. OAuth client remains private unless its owner has separately verified the domain and promoted it. Production/public promotion is never automatic.`
  );
} finally {
  await unlink(generated).catch(() => {});
}
