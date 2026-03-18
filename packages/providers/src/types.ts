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
export type ProviderConfig = HetznerProviderConfig | UpCloudProviderConfig | ScalewayProviderConfig | GcpProviderConfig;

export interface HetznerProviderConfig {
  provider: 'hetzner';
  apiToken: string;
  datacenter?: string;
  /** Delay in ms before retrying same location on 412 (default: 3000) */
  placementRetryDelayMs?: number;
  /** Whether to try other locations after primary fails (default: true) */
  placementFallbackEnabled?: boolean;
}

export interface UpCloudProviderConfig {
  provider: 'upcloud';
  username: string;
  password: string;
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
    options?: { cause?: Error },
  ) {
    super(message, options);
  }
}
