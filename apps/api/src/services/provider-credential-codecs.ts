import type { ProviderConfig } from '@simple-agent-manager/providers';
import {
  type CredentialProvider,
  GCP_CREDENTIAL_VERSION,
  type GcpCredential,
  type GcpCredentialMetadata,
} from '@simple-agent-manager/shared';

import { expectJsonRecord } from '../lib/runtime-validation';

/**
 * Serialize provider-specific credential fields into a single string for encryption.
 * Hetzner stores the raw API token; multi-field providers store JSON.
 */
export function serializeCredentialToken(
  provider: CredentialProvider,
  fields: Record<string, string>
): string {
  switch (provider) {
    case 'hetzner':
      return fields.token ?? '';
    case 'scaleway':
      return JSON.stringify({ secretKey: fields.secretKey, projectId: fields.projectId });
    case 'vultr':
      return fields.token ?? '';
    case 'infomaniak':
      return JSON.stringify({
        applicationCredentialId: fields.applicationCredentialId,
        applicationCredentialSecret: fields.applicationCredentialSecret,
      });
    case 'digitalocean':
      return fields.token ?? '';
    case 'upcloud':
      return JSON.stringify({ username: fields.username, password: fields.password });
    case 'gcp':
      return JSON.stringify({
        version: GCP_CREDENTIAL_VERSION,
        provider: 'gcp',
        authType: 'workload-identity',
        gcpProjectId: fields.gcpProjectId,
        gcpProjectNumber: fields.gcpProjectNumber,
        serviceAccountEmail: fields.serviceAccountEmail,
        wifPoolId: fields.wifPoolId,
        wifProviderId: fields.wifProviderId,
        defaultZone: fields.defaultZone,
      });
    default: {
      const _exhaustive: never = provider;
      throw new Error(`Unsupported provider: ${_exhaustive}`);
    }
  }
}

/**
 * Extract the Scaleway secret key from a decrypted Scaleway cloud credential token.
 * Returns null if the token is not valid JSON or does not contain a secretKey field.
 * Used by both the provider system and the OpenCode agent key fallback.
 */
export function extractScalewaySecretKey(decryptedToken: string): string | null {
  try {
    const parsed = expectJsonRecord(JSON.parse(decryptedToken), 'provider.scaleway_credential');
    if (typeof parsed?.secretKey === 'string' && parsed.secretKey) {
      return parsed.secretKey;
    }
    return null;
  } catch {
    return null;
  }
}

/** Parse an optional env var string to a positive integer, or return undefined. */
function parseOptionalInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Env vars that tune Hetzner provider behavior. */
export interface HetznerRuntimeEnv {
  HETZNER_CAPACITY_RETRY_INITIAL_DELAY_MS?: string;
  HETZNER_CAPACITY_RETRY_MAX_DELAY_MS?: string;
  HETZNER_CAPACITY_RETRY_MAX_ATTEMPTS?: string;
  HETZNER_CAPACITY_RETRY_BUDGET_MS?: string;
  HETZNER_MAX_LIST_PAGES?: string;
}

/** @deprecated Use HetznerRuntimeEnv. */
export type HetznerCapacityRetryEnv = HetznerRuntimeEnv;

/** Env vars that tune Vultr provider behavior (all optional; DEFAULT_VULTR_* apply otherwise). */
export interface InfomaniakRuntimeEnv {
  INFOMANIAK_AUTH_URL?: string;
  INFOMANIAK_REGION?: string;
  INFOMANIAK_ENDPOINT_INTERFACE?: string;
  INFOMANIAK_NETWORK_NAME?: string;
  INFOMANIAK_IMAGE_NAME?: string;
  INFOMANIAK_VOLUME_TYPE?: string;
  INFOMANIAK_SMALL_FLAVOR?: string;
  INFOMANIAK_MEDIUM_FLAVOR?: string;
  INFOMANIAK_LARGE_FLAVOR?: string;
  INFOMANIAK_API_TIMEOUT_MS?: string;
  INFOMANIAK_IP_POLL_TIMEOUT_MS?: string;
  INFOMANIAK_IP_POLL_INTERVAL_MS?: string;
}

export interface UpCloudRuntimeEnv {
  UPCLOUD_API_URL?: string;
  UPCLOUD_ZONE?: string;
  UPCLOUD_IMAGE_TITLE?: string;
  UPCLOUD_API_TIMEOUT_MS?: string;
  UPCLOUD_IP_POLL_TIMEOUT_MS?: string;
  UPCLOUD_IP_POLL_INTERVAL_MS?: string;
  UPCLOUD_STOP_TIMEOUT_SECONDS?: string;
}

export interface VultrRuntimeEnv {
  VULTR_REGION?: string;
  VULTR_OS_NAME?: string;
  VULTR_API_TIMEOUT_MS?: string;
  VULTR_IP_POLL_TIMEOUT_MS?: string;
  VULTR_IP_POLL_INTERVAL_MS?: string;
}

/** Env vars that tune DigitalOcean provider behavior (all optional; DEFAULT_DIGITALOCEAN_* apply otherwise). */
export interface DigitalOceanRuntimeEnv {
  DIGITALOCEAN_REGION?: string;
  DIGITALOCEAN_IMAGE?: string;
  DIGITALOCEAN_API_TIMEOUT_MS?: string;
  DIGITALOCEAN_IP_POLL_TIMEOUT_MS?: string;
  DIGITALOCEAN_IP_POLL_INTERVAL_MS?: string;
  DIGITALOCEAN_ACTION_POLL_TIMEOUT_MS?: string;
  DIGITALOCEAN_ACTION_POLL_INTERVAL_MS?: string;
  DIGITALOCEAN_MAX_LIST_PAGES?: string;
}

/**
 * Build a ProviderConfig from a provider name and decrypted credential token.
 * Handles both raw token strings (Hetzner, Vultr, DigitalOcean) and JSON blobs (Scaleway).
 */
export function buildProviderConfig(
  provider: CredentialProvider,
  decryptedToken: string,
  providerEnv?: HetznerRuntimeEnv &
    VultrRuntimeEnv &
    InfomaniakRuntimeEnv &
    DigitalOceanRuntimeEnv &
    UpCloudRuntimeEnv
): ProviderConfig {
  switch (provider) {
    case 'hetzner':
      return {
        provider: 'hetzner',
        apiToken: decryptedToken,
        capacityRetryInitialDelayMs: parseOptionalInt(
          providerEnv?.HETZNER_CAPACITY_RETRY_INITIAL_DELAY_MS
        ),
        capacityRetryMaxDelayMs: parseOptionalInt(providerEnv?.HETZNER_CAPACITY_RETRY_MAX_DELAY_MS),
        capacityRetryMaxAttempts: parseOptionalInt(
          providerEnv?.HETZNER_CAPACITY_RETRY_MAX_ATTEMPTS
        ),
        capacityRetryBudgetMs: parseOptionalInt(providerEnv?.HETZNER_CAPACITY_RETRY_BUDGET_MS),
        maxListPages: parseOptionalInt(providerEnv?.HETZNER_MAX_LIST_PAGES),
      };
    case 'vultr':
      return {
        provider: 'vultr',
        apiToken: decryptedToken,
        region: providerEnv?.VULTR_REGION,
        osName: providerEnv?.VULTR_OS_NAME,
        requestTimeoutMs: parseOptionalInt(providerEnv?.VULTR_API_TIMEOUT_MS),
        ipPollTimeoutMs: parseOptionalInt(providerEnv?.VULTR_IP_POLL_TIMEOUT_MS),
        ipPollIntervalMs: parseOptionalInt(providerEnv?.VULTR_IP_POLL_INTERVAL_MS),
      };
    case 'infomaniak': {
      let parsed: unknown;
      try {
        parsed = JSON.parse(decryptedToken);
      } catch {
        throw new Error('Invalid Infomaniak credential format: malformed stored data');
      }
      const obj = expectJsonRecord(parsed, 'provider.infomaniak_credential');
      if (
        typeof obj.applicationCredentialId !== 'string' ||
        !obj.applicationCredentialId ||
        typeof obj.applicationCredentialSecret !== 'string' ||
        !obj.applicationCredentialSecret
      )
        throw new Error(
          'Invalid Infomaniak credential format: missing application credential ID or secret'
        );
      return {
        provider: 'infomaniak',
        applicationCredentialId: obj.applicationCredentialId,
        applicationCredentialSecret: obj.applicationCredentialSecret,
        authUrl: providerEnv?.INFOMANIAK_AUTH_URL,
        region: providerEnv?.INFOMANIAK_REGION,
        endpointInterface: providerEnv?.INFOMANIAK_ENDPOINT_INTERFACE,
        networkName: providerEnv?.INFOMANIAK_NETWORK_NAME,
        imageName: providerEnv?.INFOMANIAK_IMAGE_NAME,
        volumeType: providerEnv?.INFOMANIAK_VOLUME_TYPE,
        flavors: {
          small: providerEnv?.INFOMANIAK_SMALL_FLAVOR ?? 'a2-ram4-disk20-perf1',
          medium: providerEnv?.INFOMANIAK_MEDIUM_FLAVOR ?? 'a4-ram8-disk20-perf1',
          large: providerEnv?.INFOMANIAK_LARGE_FLAVOR ?? 'a8-ram16-disk20-perf1',
        },
        requestTimeoutMs: parseOptionalInt(providerEnv?.INFOMANIAK_API_TIMEOUT_MS),
        ipPollTimeoutMs: parseOptionalInt(providerEnv?.INFOMANIAK_IP_POLL_TIMEOUT_MS),
        ipPollIntervalMs: parseOptionalInt(providerEnv?.INFOMANIAK_IP_POLL_INTERVAL_MS),
      };
    }
    case 'digitalocean':
      return {
        provider: 'digitalocean',
        apiToken: decryptedToken,
        region: providerEnv?.DIGITALOCEAN_REGION,
        image: providerEnv?.DIGITALOCEAN_IMAGE,
        requestTimeoutMs: parseOptionalInt(providerEnv?.DIGITALOCEAN_API_TIMEOUT_MS),
        ipPollTimeoutMs: parseOptionalInt(providerEnv?.DIGITALOCEAN_IP_POLL_TIMEOUT_MS),
        ipPollIntervalMs: parseOptionalInt(providerEnv?.DIGITALOCEAN_IP_POLL_INTERVAL_MS),
        actionPollTimeoutMs: parseOptionalInt(providerEnv?.DIGITALOCEAN_ACTION_POLL_TIMEOUT_MS),
        actionPollIntervalMs: parseOptionalInt(providerEnv?.DIGITALOCEAN_ACTION_POLL_INTERVAL_MS),
        maxListPages: parseOptionalInt(providerEnv?.DIGITALOCEAN_MAX_LIST_PAGES),
      };
    case 'upcloud': {
      let parsed: unknown;
      try {
        parsed = JSON.parse(decryptedToken);
      } catch {
        throw new Error('Invalid UpCloud credential format: malformed stored data');
      }
      const obj = expectJsonRecord(parsed, 'provider.upcloud_credential');
      if (
        typeof obj.username !== 'string' ||
        !obj.username ||
        typeof obj.password !== 'string' ||
        !obj.password
      )
        throw new Error('Invalid UpCloud credential format: missing username or password');
      return {
        provider: 'upcloud',
        username: obj.username,
        password: obj.password,
        apiUrl: providerEnv?.UPCLOUD_API_URL,
        zone: providerEnv?.UPCLOUD_ZONE,
        imageTitle: providerEnv?.UPCLOUD_IMAGE_TITLE,
        requestTimeoutMs: parseOptionalInt(providerEnv?.UPCLOUD_API_TIMEOUT_MS),
        ipPollTimeoutMs: parseOptionalInt(providerEnv?.UPCLOUD_IP_POLL_TIMEOUT_MS),
        ipPollIntervalMs: parseOptionalInt(providerEnv?.UPCLOUD_IP_POLL_INTERVAL_MS),
        stopTimeoutSeconds: parseOptionalInt(providerEnv?.UPCLOUD_STOP_TIMEOUT_SECONDS),
      };
    }
    case 'scaleway': {
      let parsed: unknown;
      try {
        parsed = JSON.parse(decryptedToken);
      } catch {
        throw new Error('Invalid Scaleway credential format: malformed stored data');
      }
      const obj = expectJsonRecord(parsed, 'provider.scaleway_credential');
      if (
        typeof obj?.secretKey !== 'string' ||
        !obj.secretKey ||
        typeof obj?.projectId !== 'string' ||
        !obj.projectId
      ) {
        throw new Error('Invalid Scaleway credential format: missing secretKey or projectId');
      }
      return { provider: 'scaleway', secretKey: obj.secretKey, projectId: obj.projectId };
    }
    case 'gcp':
      // GCP credentials are metadata (not secrets). The tokenProvider must be injected
      // at a higher layer via buildGcpProviderConfig() since it depends on the env/JWT context.
      throw new Error(
        'GCP credentials require buildGcpProviderConfig() — cannot use buildProviderConfig() directly'
      );
    default:
      throw new Error(`Unsupported provider: ${provider}`);
  }
}

function requiredGcpString(obj: Record<string, unknown>, field: string): string {
  const value = obj[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Invalid GCP credential format: missing ${field}`);
  }
  return value;
}

/** Return the browser-safe projection of a normalized GCP credential. */
export function toGcpCredentialMetadata(credential: GcpCredential): GcpCredentialMetadata {
  return {
    authType: credential.authType,
    gcpProjectId: credential.gcpProjectId,
    serviceAccountEmail: credential.serviceAccountEmail,
    defaultZone: credential.defaultZone,
    ...(credential.authType === 'service-account-key'
      ? { privateKeyId: credential.privateKeyId }
      : {}),
  };
}

/** Serialize a normalized, versioned GCP credential for encrypted storage. */
export function serializeGcpCredential(credential: GcpCredential): string {
  return JSON.stringify(credential);
}

/**
 * Parse a decrypted GCP credential token. Existing unversioned blobs are
 * normalized as workload-identity credentials for migration-free compatibility.
 */
export function parseGcpCredential(decryptedToken: string): GcpCredential {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decryptedToken);
  } catch {
    throw new Error('Invalid GCP credential format: malformed stored data');
  }
  const obj = expectJsonRecord(parsed, 'provider.gcp_credential');
  if (typeof obj.provider === 'string' && obj.provider !== 'gcp') {
    throw new Error('Invalid GCP credential format: provider mismatch');
  }

  const legacy = obj.authType === undefined && obj.version === undefined;
  if (!legacy && obj.version !== GCP_CREDENTIAL_VERSION) {
    throw new Error('Invalid GCP credential format: unsupported version');
  }
  const authType = legacy ? 'workload-identity' : obj.authType;

  if (authType === 'workload-identity') {
    return {
      version: GCP_CREDENTIAL_VERSION,
      provider: 'gcp',
      authType,
      gcpProjectId: requiredGcpString(obj, 'gcpProjectId'),
      gcpProjectNumber: requiredGcpString(obj, 'gcpProjectNumber'),
      serviceAccountEmail: requiredGcpString(obj, 'serviceAccountEmail'),
      wifPoolId: requiredGcpString(obj, 'wifPoolId'),
      wifProviderId: requiredGcpString(obj, 'wifProviderId'),
      defaultZone: requiredGcpString(obj, 'defaultZone'),
    };
  }

  if (authType === 'service-account-key') {
    return {
      version: GCP_CREDENTIAL_VERSION,
      provider: 'gcp',
      authType,
      gcpProjectId: requiredGcpString(obj, 'gcpProjectId'),
      serviceAccountEmail: requiredGcpString(obj, 'serviceAccountEmail'),
      privateKeyId: requiredGcpString(obj, 'privateKeyId'),
      privateKey: requiredGcpString(obj, 'privateKey'),
      defaultZone: requiredGcpString(obj, 'defaultZone'),
    };
  }

  throw new Error('Invalid GCP credential format: unsupported authType');
}

/**
 * Normalize a stored cloud-provider credential payload into the provider token
 * consumed by provider constructors. Legacy rows store raw provider tokens;
 * composable credentials may store `{ provider, token }` wrapper JSON.
 */
export function extractCloudProviderToken(
  provider: string,
  decryptedToken: string
): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decryptedToken);
  } catch {
    return decryptedToken;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return decryptedToken;
  const record = parsed as Record<string, unknown>;
  const parsedProvider = record.provider;
  if (typeof parsedProvider === 'string' && parsedProvider.trim() && parsedProvider !== provider) {
    throw new Error('Invalid cloud provider credential format: provider mismatch');
  }

  const token = record.token;
  return typeof token === 'string' && token.trim() ? token : decryptedToken;
}
