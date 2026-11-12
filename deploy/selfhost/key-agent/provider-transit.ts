/**
 * HashiCorp Vault or OpenBao transit engine (same HTTP API). The KEK is a transit key
 * (`aes256-gcm96`) that never leaves the server; the box holds only a credential whose policy
 * allows `transit/encrypt/<key>` and `transit/decrypt/<key>` and nothing else.
 *
 * Auth, in order: AppRole (`SAM_TRANSIT_ROLE_ID` + `SAM_TRANSIT_SECRET_ID_FILE`, recommended: the
 * secret id can be bound to this box's address with `secret_id_bound_cidrs`) or a token file
 * (`SAM_TRANSIT_TOKEN_FILE`). Credentials are read from files, never from the environment, so
 * `docker inspect` does not show them.
 */
import { readFileSync } from 'node:fs';

import {
  b64,
  field,
  jsonCall,
  type KeyProvider,
  KeyProviderError,
  requireSetting,
  unb64,
} from './provider.ts';

const KEY_NAME = /^[A-Za-z0-9_.-]{1,128}$/;
const MOUNT = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/;
/** Renew the AppRole token this long before the server says it expires. */
const TOKEN_REFRESH_MARGIN_MS = 30_000;

function readCredential(path: string, what: string): string {
  try {
    const value = readFileSync(path, 'utf8').trim();
    if (value) return value;
  } catch {
    // fall through
  }
  throw new KeyProviderError('config', `cannot read the transit ${what} file ${path}`);
}

export function createTransitProvider(
  env: Readonly<Record<string, string | undefined>>
): KeyProvider {
  const addr = requireSetting(env, 'SAM_TRANSIT_ADDR').replace(/\/+$/, '');
  const mount = env.SAM_TRANSIT_MOUNT?.trim() || 'transit';
  const key = requireSetting(env, 'SAM_TRANSIT_KEY');
  if (!MOUNT.test(mount)) throw new KeyProviderError('config', 'SAM_TRANSIT_MOUNT is not a path');
  if (!KEY_NAME.test(key)) throw new KeyProviderError('config', 'SAM_TRANSIT_KEY is not a key name');
  const url = new URL(addr);
  // Plain HTTP only to this machine (a sidecar); anything else must be TLS.
  if (url.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new KeyProviderError('config', 'SAM_TRANSIT_ADDR must be https:// unless on loopback');
  }
  const namespace = env.SAM_TRANSIT_NAMESPACE?.trim();
  const roleId = env.SAM_TRANSIT_ROLE_ID?.trim();
  const secretIdFile = env.SAM_TRANSIT_SECRET_ID_FILE?.trim();
  const tokenFile = env.SAM_TRANSIT_TOKEN_FILE?.trim();
  if (!(roleId && secretIdFile) && !tokenFile) {
    throw new KeyProviderError(
      'config',
      'transit needs SAM_TRANSIT_ROLE_ID + SAM_TRANSIT_SECRET_ID_FILE, or SAM_TRANSIT_TOKEN_FILE'
    );
  }
  const service = `transit ${url.host}/${mount}/${key}`;
  let token: { value: string; expiresAt: number } | null = null;

  async function clientToken(): Promise<string> {
    if (!(roleId && secretIdFile)) return readCredential(tokenFile ?? '', 'token');
    if (token && Date.now() < token.expiresAt) return token.value;
    const login = await jsonCall(`${addr}/v1/auth/approle/login`, {
      service: `${service} (approle login)`,
      headers: namespace ? { 'X-Vault-Namespace': namespace } : {},
      body: { role_id: roleId, secret_id: readCredential(secretIdFile, 'secret id') },
    });
    const value = field(login, 'auth', 'client_token');
    const ttl = Number(field(login, 'auth', 'lease_duration'));
    if (typeof value !== 'string' || !value) {
      throw new KeyProviderError('unavailable', `${service}: login returned no token`);
    }
    token = {
      value,
      expiresAt: Date.now() + Math.max(0, (Number.isFinite(ttl) ? ttl : 0) * 1000 - TOKEN_REFRESH_MARGIN_MS),
    };
    return value;
  }

  async function call(op: 'encrypt' | 'decrypt', body: Record<string, string>): Promise<unknown> {
    const headers: Record<string, string> = { 'X-Vault-Token': await clientToken() };
    if (namespace) headers['X-Vault-Namespace'] = namespace;
    try {
      return await jsonCall(`${addr}/v1/${mount}/${op}/${key}`, { service, headers, body });
    } catch (error) {
      // Transit answers 400 for a ciphertext or associated data that does not verify.
      if (error instanceof KeyProviderError && error.kind === 'denied') token = null;
      throw error;
    }
  }

  return {
    name: 'transit',
    keyRef: `${url.host}/${mount}/${key}`,
    bindsContext: true,
    async wrap(dataKey, context) {
      const result = await call('encrypt', {
        plaintext: b64(dataKey),
        associated_data: b64(context),
      });
      const ciphertext = field(result, 'data', 'ciphertext');
      if (typeof ciphertext !== 'string' || !ciphertext.startsWith('vault:v')) {
        throw new KeyProviderError('unavailable', `${service}: encrypt returned no ciphertext`);
      }
      return new Uint8Array(Buffer.from(ciphertext, 'utf8'));
    },
    async unwrap(wrapped, context) {
      const ciphertext = Buffer.from(wrapped).toString('utf8');
      if (!/^vault:v\d+:[A-Za-z0-9+/=]+$/.test(ciphertext)) {
        throw new KeyProviderError('invalid', `${service}: wrapped key is not a transit ciphertext`);
      }
      const result = await call('decrypt', { ciphertext, associated_data: b64(context) });
      return unb64(field(result, 'data', 'plaintext'), `${service}: plaintext`);
    },
  };
}
