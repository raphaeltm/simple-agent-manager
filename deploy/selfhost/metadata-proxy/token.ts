/** Fixed-bucket Google CAB exchange. The source VM token never leaves this process. */
import { Gaxios } from 'gaxios';
import { StsCredentials } from 'google-auth-library/build/src/auth/stscredentials.js';

export const STORAGE_SCOPE_PREFIX = 'https://www.googleapis.com/auth/devstorage.';
export const METADATA_TOKEN_PATH = '/computeMetadata/v1/instance/service-accounts/default/token';
const METADATA_URL = `http://169.254.169.254${METADATA_TOKEN_PATH}`;
const STS_URL = 'https://sts.googleapis.com/v1/token';
const DEFAULT_ENDPOINTS = { metadata: METADATA_URL, sts: STS_URL };

export interface TokenConfig {
  bucket: string;
  scope: string;
  timeoutMs: number;
  maxResponseBytes: number;
}

export function accessBoundary(config: TokenConfig) {
  if (!/^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/.test(config.bucket) || config.bucket.includes('..')) {
    throw new Error('invalid metadata proxy bucket');
  }
  const roles: Record<string, string> = {
    [`${STORAGE_SCOPE_PREFIX}read_only`]: 'inRole:roles/storage.objectViewer',
    [`${STORAGE_SCOPE_PREFIX}read_write`]: 'inRole:roles/storage.objectAdmin',
  };
  const role = Object.hasOwn(roles, config.scope) ? roles[config.scope] : undefined;
  if (!role) throw new Error('metadata proxy requires one supported storage scope');
  return {
    accessBoundary: {
      accessBoundaryRules: [
        {
          availableResource: `//storage.googleapis.com/projects/_/buckets/${config.bucket}`,
          availablePermissions: [role],
        },
      ],
    },
  };
}

interface Token {
  access_token: string;
  expires_in: number;
  token_type: 'Bearer';
}
function token(value: unknown): Token {
  if (typeof value !== 'object' || value === null) throw new Error('invalid token response');
  const item = value as Record<string, unknown>;
  if (
    typeof item.access_token !== 'string' ||
    item.access_token.length === 0 ||
    typeof item.expires_in !== 'number' ||
    !Number.isFinite(item.expires_in) ||
    item.expires_in < 1 ||
    item.expires_in > 3600 ||
    item.token_type !== 'Bearer'
  ) {
    throw new Error('invalid token response');
  }
  return { access_token: item.access_token, expires_in: item.expires_in, token_type: 'Bearer' };
}

/** URL injection is a test seam only; production main supplies neither endpoint. */
export function tokenSource(config: TokenConfig, endpoints = DEFAULT_ENDPOINTS) {
  const boundary = accessBoundary(config);
  const transporter = new Gaxios({
    timeout: config.timeoutMs,
    // Gaxios maps maxRedirects/maxContentLength only from per-request options. These
    // fetch-native defaults survive merging for both metadata and SDK-owned STS requests.
    redirect: 'error',
    size: config.maxResponseBytes,
    // Metadata makes one attempt; the pinned STS SDK supplies its own bounded retry policy.
    retry: false,
  });
  // The pinned official SDK's public STS class supports transporter limits. DownscopedClient
  // constructs its own unbounded STS transporter, so use the lower-level SDK extension here.
  const sts = new StsCredentials({ tokenExchangeEndpoint: endpoints.sts, transporter });
  let cached: { value: Token; expiresAt: number } | undefined;
  let pending: Promise<Token> | undefined;
  const mint = async (): Promise<Token> => {
    const source = token(
      (
        await transporter.request<unknown>({
          url: endpoints.metadata,
          method: 'GET',
          headers: { 'Metadata-Flavor': 'Google' },
          responseType: 'json',
        })
      ).data
    );
    const sourceExpiry = Date.now() + source.expires_in * 1000;
    const exchanged = await sts.exchangeToken(
      {
        grantType: 'urn:ietf:params:oauth:grant-type:token-exchange',
        requestedTokenType: 'urn:ietf:params:oauth:token-type:access_token',
        subjectTokenType: 'urn:ietf:params:oauth:token-type:access_token',
        subjectToken: source.access_token,
      },
      undefined,
      boundary
    );
    const remaining = Math.floor((sourceExpiry - Date.now()) / 1000);
    const value = token({
      ...exchanged,
      expires_in: Math.min(exchanged.expires_in ?? remaining, remaining),
    });
    if (value.access_token === source.access_token) throw new Error('token was not exchanged');
    cached = { value, expiresAt: Date.now() + value.expires_in * 1000 };
    return value;
  };
  return async (): Promise<Token> => {
    if (cached && cached.expiresAt - Date.now() > 60_000) {
      return { ...cached.value, expires_in: Math.floor((cached.expiresAt - Date.now()) / 1000) };
    }
    pending ??= mint().finally(() => {
      pending = undefined;
    });
    return pending;
  };
}
