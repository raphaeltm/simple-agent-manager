import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Shared by deploy.mjs, remove.mjs and check-live.mjs: which installer Worker a command
// acts on, the Cloudflare API client, numeric settings, and the Wrangler runner.
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

// What the token form calls a permission, and its name in Cloudflare's API catalog.
const PERMISSION_LABELS = {
  'OAuth Client Write': 'Account → OAuth Client → Edit',
  'Workers Scripts Write': 'Account → Workers Scripts → Edit',
};
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
        ? `Cloudflare refused ${method} (${detail}). Check the API token's permissions: it needs ${PERMISSION_LABELS[permission]} ("${permission}" in Cloudflare's API) on this account. Private response omitted.`
        : `Cloudflare ${method} failed (${detail}). Verify the required API permissions. Private response omitted.`
    );
    this.status = status;
    this.permission = permission;
    this.codes = codes;
  }
}

// Node treats a larger timer delay as 1 ms, which would turn a poll into a tight loop.
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * A whole number from `minimum` to `maximum` from the environment; unset or empty gives
 * `fallback`. Anything else stops the command: a NaN deadline would never be reached.
 */
export function intFromEnv(name, fallback, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum)
    throw new Error(`${name} must be a whole number from ${minimum} to ${maximum}.`);
  return value;
}

/** A poll or retry interval: at least 1 ms and within what a timer can wait. */
export const delayFromEnv = (name, fallback) => intFromEnv(name, fallback, 1, MAX_TIMER_DELAY_MS);

/** OAuth client endpoints use `registrationToken` when one is supplied. */
export function createApi({ token, base, registrationToken }) {
  return async function api(path, method = 'GET', body = undefined) {
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
    } catch {
      throw new Error('Cloudflare request could not complete. Private response omitted.');
    }
    // A refusal can arrive with an empty or non-JSON body; its status still decides.
    data = await response.json().catch(() => undefined);
    if (!response.ok || !data || data.success === false)
      throw new ApiFailure(
        response.status,
        method,
        permissionFor(path, base),
        (Array.isArray(data?.errors) ? data.errors : [])
          .map((error) => error?.code)
          .filter((code) => Number.isInteger(code))
      );
    return data.result;
  };
}

/**
 * Runs this package's Wrangler, through the running Node binary rather than PATH, without
 * OAuth credentials in its environment.
 */
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
