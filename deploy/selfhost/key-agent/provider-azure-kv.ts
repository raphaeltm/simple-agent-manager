/**
 * Azure Key Vault (or Managed HSM) `wrapkey` / `unwrapkey`, authenticated by the VM's managed
 * identity through IMDS: nothing is stored on the box. Grant the identity the "Key Vault Crypto
 * Service Encryption User" role on this key only.
 *
 * RSA-OAEP-256 wrapKey has no associated data, so `bindsContext` is false: the bundle's own AEAD
 * still binds the header, and the wrapped blob records the exact key version (`kid`) so a KEK
 * rotation (new key version) leaves old bundles unwrappable until they are resealed.
 *
 * Tested against a fake only (scripts/selfhost/key-provider-fakes.ts), never the real service.
 */
import {
  field,
  jsonCall,
  type KeyProvider,
  KeyProviderError,
  requireSetting,
} from './provider.ts';

const API_VERSION = '7.4';
const KEY_NAME = /^[A-Za-z0-9-]{1,127}$/;
const TOKEN_REFRESH_MARGIN_MS = 60_000;

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

function unb64url(text: unknown, what: string): Uint8Array {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]+$/.test(text)) {
    throw new KeyProviderError('invalid', `${what} is not base64url`);
  }
  return new Uint8Array(Buffer.from(text, 'base64url'));
}

export function createAzureKeyVaultProvider(
  env: Readonly<Record<string, string | undefined>>
): KeyProvider {
  const vault = requireSetting(env, 'SAM_AZURE_KEY_VAULT_URL').replace(/\/+$/, '');
  const keyName = requireSetting(env, 'SAM_AZURE_KEY_NAME');
  if (!KEY_NAME.test(keyName)) throw new KeyProviderError('config', 'SAM_AZURE_KEY_NAME is invalid');
  const vaultUrl = new URL(vault);
  const allowHttp = env.SAM_AZURE_ALLOW_HTTP_FOR_TESTS === '1';
  if (vaultUrl.protocol !== 'https:' && !allowHttp) {
    throw new KeyProviderError('config', 'SAM_AZURE_KEY_VAULT_URL must be https://');
  }
  const imds = env.SAM_AZURE_IMDS_HOST?.trim() || '169.254.169.254';
  // Managed HSM uses a different token audience.
  const resource = vaultUrl.hostname.endsWith('.managedhsm.azure.net')
    ? 'https://managedhsm.azure.net'
    : 'https://vault.azure.net';
  const keyPrefix = `${vault}/keys/${keyName}/`;
  const service = `azure-kv ${vaultUrl.host}/${keyName}`;
  let token: { value: string; expiresAt: number } | null = null;

  async function accessToken(): Promise<string> {
    if (token && Date.now() < token.expiresAt) return token.value;
    const query = new URLSearchParams({ 'api-version': '2018-02-01', resource });
    const clientId = env.SAM_AZURE_CLIENT_ID?.trim();
    if (clientId) query.set('client_id', clientId);
    const result = await jsonCall(`http://${imds}/metadata/identity/oauth2/token?${query}`, {
      method: 'GET',
      service: 'azure imds',
      headers: { Metadata: 'true' },
    });
    const value = field(result, 'access_token');
    const expiresIn = Number(field(result, 'expires_in'));
    if (typeof value !== 'string' || !value) {
      throw new KeyProviderError('unavailable', 'azure imds returned no access token');
    }
    token = {
      value,
      expiresAt: Date.now() + Math.max(0, (Number.isFinite(expiresIn) ? expiresIn : 0) * 1000 - TOKEN_REFRESH_MARGIN_MS),
    };
    return value;
  }

  async function call(url: string, body: Record<string, string>): Promise<unknown> {
    try {
      return await jsonCall(`${url}?api-version=${API_VERSION}`, {
        service,
        headers: { authorization: `Bearer ${await accessToken()}` },
        body,
      });
    } catch (error) {
      if (error instanceof KeyProviderError && error.kind === 'denied') token = null;
      throw error;
    }
  }

  return {
    name: 'azure-kv',
    keyRef: `${vaultUrl.host}/keys/${keyName}`,
    bindsContext: false,
    async wrap(dataKey) {
      // No version: the current key version wraps; its kid is recorded for unwrap.
      const result = await call(`${vault}/keys/${keyName}/wrapkey`, {
        alg: 'RSA-OAEP-256',
        value: b64url(dataKey),
      });
      const kid = field(result, 'kid');
      const value = field(result, 'value');
      if (typeof kid !== 'string' || !kid.startsWith(keyPrefix) || typeof value !== 'string') {
        throw new KeyProviderError('unavailable', `${service}: wrapkey returned no key version`);
      }
      return new Uint8Array(Buffer.from(JSON.stringify({ kid, value }), 'utf8'));
    },
    async unwrap(wrapped) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.from(wrapped).toString('utf8')) as unknown;
      } catch {
        throw new KeyProviderError('invalid', `${service}: wrapped key is not JSON`);
      }
      const kid = field(parsed, 'kid');
      const value = field(parsed, 'value');
      if (typeof kid !== 'string' || !kid.startsWith(keyPrefix) || !/^[A-Za-z0-9]+$/.test(kid.slice(keyPrefix.length))) {
        throw new KeyProviderError('invalid', `${service}: wrapped key names another key`);
      }
      unb64url(value, `${service}: wrapped value`);
      const result = await call(`${kid}/unwrapkey`, { alg: 'RSA-OAEP-256', value: value as string });
      return unb64url(field(result, 'value'), `${service}: unwrapped value`);
    },
  };
}
