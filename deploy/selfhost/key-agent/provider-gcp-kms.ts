/**
 * Google Cloud KMS, authenticated by the VM's attached service account through the metadata
 * server: nothing is stored on the box. Grant that account `roles/cloudkms.cryptoKeyEncrypterDecrypter`
 * on this one key only (a key-level binding).
 *
 * REST: POST {endpoint}/v1/{key}:encrypt|decrypt with `additionalAuthenticatedData`.
 * `SAM_GCP_KMS_ENDPOINT` and `SAM_GCE_METADATA_HOST` exist for tests against a fake.
 */
import {
  b64,
  field,
  jsonCall,
  type KeyProvider,
  KeyProviderError,
  requireSetting,
  unb64,
} from './provider.ts';

const KEY_NAME =
  /^projects\/[a-z][a-z0-9-]{4,28}[a-z0-9]\/locations\/[a-z0-9-]+\/keyRings\/[A-Za-z0-9_-]{1,63}\/cryptoKeys\/[A-Za-z0-9_-]{1,63}$/;
const TOKEN_REFRESH_MARGIN_MS = 60_000;
const LOOPBACK = ['127.0.0.1', 'localhost', '[::1]'];
const HOST = /^[A-Za-z0-9.-]+(:\d{1,5})?$/;

export function createGcpKmsProvider(
  env: Readonly<Record<string, string | undefined>>
): KeyProvider {
  const key = requireSetting(env, 'SAM_GCP_KMS_KEY');
  if (!KEY_NAME.test(key)) {
    throw new KeyProviderError(
      'config',
      'SAM_GCP_KMS_KEY must be projects/P/locations/L/keyRings/R/cryptoKeys/K'
    );
  }
  const endpoint = (env.SAM_GCP_KMS_ENDPOINT?.trim() || 'https://cloudkms.googleapis.com').replace(
    /\/+$/,
    ''
  );
  // The data key and the bearer token travel in this request: TLS, unless a loopback test fake.
  const endpointUrl = new URL(endpoint);
  if (endpointUrl.protocol !== 'https:' && !LOOPBACK.includes(endpointUrl.hostname)) {
    throw new KeyProviderError(
      'config',
      'SAM_GCP_KMS_ENDPOINT must be https:// unless on loopback'
    );
  }
  // The link-local address, not the DNS name: a resolver cannot redirect it.
  const metadataHost = env.SAM_GCE_METADATA_HOST?.trim() || '169.254.169.254';
  if (!HOST.test(metadataHost)) {
    throw new KeyProviderError('config', 'SAM_GCE_METADATA_HOST must be a host or host:port');
  }
  const service = `gcp-kms ${key}`;
  let token: { value: string; expiresAt: number } | null = null;

  async function accessToken(): Promise<string> {
    if (token && Date.now() < token.expiresAt) return token.value;
    const result = await jsonCall(
      `http://${metadataHost}/computeMetadata/v1/instance/service-accounts/default/token`,
      { method: 'GET', service: 'gce metadata server', headers: { 'Metadata-Flavor': 'Google' } }
    );
    const value = field(result, 'access_token');
    const expiresIn = Number(field(result, 'expires_in'));
    if (typeof value !== 'string' || !value) {
      throw new KeyProviderError('unavailable', 'gce metadata server returned no access token');
    }
    token = {
      value,
      expiresAt:
        Date.now() +
        Math.max(0, (Number.isFinite(expiresIn) ? expiresIn : 0) * 1000 - TOKEN_REFRESH_MARGIN_MS),
    };
    return value;
  }

  async function call(op: 'encrypt' | 'decrypt', body: Record<string, string>): Promise<unknown> {
    try {
      return await jsonCall(`${endpoint}/v1/${key}:${op}`, {
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
    name: 'gcp-kms',
    keyRef: key,
    bindsContext: true,
    async wrap(dataKey, context) {
      const result = await call('encrypt', {
        plaintext: b64(dataKey),
        additionalAuthenticatedData: b64(context),
      });
      return unb64(field(result, 'ciphertext'), `${service}: ciphertext`);
    },
    async unwrap(wrapped, context) {
      const result = await call('decrypt', {
        ciphertext: b64(wrapped),
        additionalAuthenticatedData: b64(context),
      });
      return unb64(field(result, 'plaintext'), `${service}: plaintext`);
    },
  };
}
