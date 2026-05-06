import type { VMSize } from '@simple-agent-manager/shared';

/**
 * Configuration for creating a VM.
 * Contains ONLY non-secret operational parameters.
 * Secrets (API tokens, auth passwords, GitHub tokens) belong in cloud-init generation,
 * not in the provider layer.
 */
export interface VMConfig {
  /** Server name */
  name: string;

  /** VM size tier */
  size: VMSize;

  /** Datacenter/region identifier */
  location: string;

  /** Pre-generated cloud-init script (opaque to provider) */
  userData: string;

  /** Metadata labels for the VM */
  labels?: Record<string, string>;

  /** OS image override (default: provider-specific) */
  image?: string;
}

/**
 * VM status as reported by the provider
 */
export type VMStatus = 'initializing' | 'running' | 'off' | 'starting' | 'stopping';

/**
 * VM instance as returned by provider
 */
export interface VMInstance {
  /** Provider-specific server ID */
  id: string;

  /** Server name */
  name: string;

  /** Public IPv4 address */
  ip: string;

  /** Provider-reported status */
  status: VMStatus;

  /** Server type (e.g., "cx23") */
  serverType: string;

  /** ISO 8601 creation timestamp */
  createdAt: string;

  /** Labels attached to server */
  labels: Record<string, string>;
}

/**
 * Size configuration for a VM tier
 */
export interface SizeConfig {
  /** Provider-specific server type */
  type: string;

  /** Monthly price string */
  price: string;

  /** vCPU count */
  vcpu: number;

  /** RAM in GB */
  ramGb: number;

  /** Storage in GB */
  storageGb: number;
}

/** Location metadata for display purposes */
export interface LocationMeta {
  name: string;
  country: string;
}

/**
 * Cloud provider interface.
 * Implementations handle VM lifecycle through their respective cloud APIs.
 */
export interface Provider {
  /** Provider identifier matching CredentialProvider type */
  readonly name: string;

  /** Available datacenter/region identifiers */
  readonly locations: readonly string[];

  /** Human-readable metadata for each location */
  readonly locationMetadata: Readonly<Record<string, LocationMeta>>;

  /** Available VM size configurations */
  readonly sizes: Readonly<Record<VMSize, SizeConfig>>;

  /** Default location for this provider */
  readonly defaultLocation: string;

  /** Provision a new VM */
  createVM(config: VMConfig): Promise<VMInstance>;

  /** Delete a VM. MUST be idempotent (no error on 404). */
  deleteVM(id: string): Promise<void>;

  /** Get VM by ID. Returns null if not found (no throw). */
  getVM(id: string): Promise<VMInstance | null>;

  /** List VMs with optional label-based filtering */
  listVMs(labels?: Record<string, string>): Promise<VMInstance[]>;

  /** Power off a VM */
  powerOff(id: string): Promise<void>;

  /** Power on a VM */
  powerOn(id: string): Promise<void>;

  /** Validate provider credentials. Returns true if valid, throws ProviderError on failure. */
  validateToken(): Promise<boolean>;
}

/**
 * Provider configuration — discriminated union per provider type.
 * Accepts explicit credentials; MUST NOT access process.env.
 */
export type ProviderConfig = HetznerProviderConfig | ScalewayProviderConfig | GcpProviderConfig;

export interface HetznerProviderConfig {
  provider: 'hetzner';
  apiToken: string;
  datacenter?: string;
  /** Per-request API timeout in ms (default: 30000) */
  timeoutMs?: number;
  /** Max HTTP retry attempts for transient provider API calls (default: 3) */
  apiRetryMaxAttempts?: number;
  /** Base delay in ms for transient provider API retries (default: 1000) */
  apiRetryBaseDelayMs?: number;
  /** Max delay in ms for transient provider API retries (default: 10000) */
  apiRetryMaxDelayMs?: number;
  /** Delay in ms before retrying same location on 412 (default: 3000) */
  placementRetryDelayMs?: number;
  /** Number of primary-location placement attempts before fallback locations (default: 2) */
  placementRetryAttempts?: number;
  /** Whether to try other locations after primary fails (default: true) */
  placementFallbackEnabled?: boolean;
  /** Ordered fallback locations to try after primary placement attempts fail */
  placementFallbackLocations?: string[];
}

export interface ScalewayProviderConfig {
  provider: 'scaleway';
  secretKey: string;
  projectId: string;
  zone?: string;
}

export interface GcpProviderConfig {
  provider: 'gcp';
  projectId: string;
  /** Function that returns a valid GCP access token (via STS exchange) */
  tokenProvider: () => Promise<string>;
  defaultZone?: string;
  imageFamily?: string;
  imageProject?: string;
  diskSizeGb?: number;
  timeoutMs?: number;
  operationPollTimeoutMs?: number;
}

/**
 * Normalized error for all provider operations.
 * Wraps HTTP errors, timeouts, and domain-specific failures with provider context.
 */
export class ProviderError extends Error {
  override readonly name = 'ProviderError';

  constructor(
    /** Provider that produced the error */
    public readonly providerName: string,
    /** HTTP status code (if from API call) */
    public readonly statusCode: number | undefined,
    message: string,
    /** Original error */
    options?: {
      cause?: Error;
      retryable?: boolean;
      reason?: ProviderErrorReason;
      retryAfterMs?: number;
      idempotencyRisk?: ProviderIdempotencyRisk;
    },
  ) {
    super(message, options);
    this.retryable = options?.retryable ?? false;
    this.reason = options?.reason ?? classifyProviderErrorReason(statusCode);
    this.retryAfterMs = options?.retryAfterMs;
    this.idempotencyRisk = options?.idempotencyRisk ?? 'none';
  }

  readonly retryable: boolean;
  readonly reason: ProviderErrorReason;
  readonly retryAfterMs: number | undefined;
  readonly idempotencyRisk: ProviderIdempotencyRisk;

  /** Make Error properties visible to JSON.stringify */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      provider: this.providerName,
      statusCode: this.statusCode,
      retryable: this.retryable,
      reason: this.reason,
      retryAfterMs: this.retryAfterMs,
      idempotencyRisk: this.idempotencyRisk,
      cause: this.cause instanceof Error ? this.cause.message : this.cause,
    };
  }
}

export type ProviderErrorReason =
  | 'network'
  | 'timeout'
  | 'rate_limit'
  | 'provider_5xx'
  | 'capacity'
  | 'placement'
  | 'quota'
  | 'auth'
  | 'validation'
  | 'not_found'
  | 'conflict'
  | 'unknown';

export type ProviderIdempotencyRisk = 'none' | 'duplicate_resource' | 'destructive';

function classifyProviderErrorReason(statusCode: number | undefined): ProviderErrorReason {
  if (statusCode === undefined) return 'unknown';
  if (statusCode === 401 || statusCode === 403) return 'auth';
  if (statusCode === 404) return 'not_found';
  if (statusCode === 409) return 'conflict';
  if (statusCode === 429) return 'rate_limit';
  if (statusCode >= 400 && statusCode < 500) return 'validation';
  if (statusCode >= 500) return 'provider_5xx';
  return 'unknown';
}
