import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Shared by deploy.mjs and remove.mjs: which installer Worker a command acts on,
// the Cloudflare API client, and the Wrangler runner.
export const SECRET_NAMES = ['OAUTH_CLIENT_ID', 'OAUTH_CLIENT_SECRET'];

/** The installer Worker this command acts on, from the environment. */
export function readTarget(env = process.env) {
  const token = env.CLOUDFLARE_API_TOKEN;
  const account = env.CLOUDFLARE_ACCOUNT_ID;
  const environment = env.INSTALLER_ENVIRONMENT || 'self-hosted';
  if (!token || !/^[a-f0-9]{32}$/.test(account || ''))
    throw new Error('Set CLOUDFLARE_API_TOKEN and a valid CLOUDFLARE_ACCOUNT_ID.');
  if (!/^[a-z0-9-]+$/.test(environment)) throw new Error('Invalid installer environment');
  const name = `sam-installer-${environment}`;
  const base = `/accounts/${account}`;
  return { token, account, environment, name, base, worker: `${base}/workers/scripts/${name}` };
}

// Account API token permission-group names (Cloudflare catalog vocabulary).
function permissionFor(path, base) {
  if (path === '/oauth/scopes' || path.startsWith(`${base}/oauth_clients`))
    return 'OAuth Client Write';
  if (path.startsWith(`${base}/workers/`)) return 'Workers Scripts Write';
  return undefined;
}

export class ApiFailure extends Error {
  // `codes` are Cloudflare's numeric error codes: diagnostic, never response text,
  // which can echo request values.
  constructor(status, method, permission, codes = []) {
    const detail = codes.length ? `${status}, Cloudflare code ${codes.join(', ')}` : `${status}`;
    super(
      (status === 401 || status === 403) && permission
        ? `Cloudflare refused ${method} (${detail}). Check the API token's permissions: it needs "${permission}" on this account. Private response omitted.`
        : `Cloudflare ${method} failed (${detail}). Verify the required API permissions. Private response omitted.`
    );
    this.status = status;
    this.permission = permission;
    this.codes = codes;
  }
}

/** OAuth client endpoints use `registrationToken` when one is supplied. */
export function createApi({ token, base, registrationToken }) {
  return async function api(path, method = 'GET', body) {
    const oauthApi = path === '/oauth/scopes' || path.startsWith(`${base}/oauth_clients`);
    const authorization = oauthApi ? registrationToken || token : token;
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
    if (!response.ok || data.success === false)
      throw new ApiFailure(
        response.status,
        method,
        permissionFor(path, base),
        (Array.isArray(data.errors) ? data.errors : [])
          .map((error) => error?.code)
          .filter((code) => Number.isInteger(code))
      );
    return data.result;
  };
}

/** Runs this package's Wrangler without OAuth credentials in its environment. */
export function wrangler(args) {
  const childEnvironment = { ...process.env };
  for (const key of ['OAUTH_REGISTRATION_TOKEN', ...SECRET_NAMES]) delete childEnvironment[key];
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url)), ...args],
    {
      stdio: 'inherit',
      env: childEnvironment,
    }
  );
  if (result.status !== 0) throw new Error('Wrangler command failed');
}
