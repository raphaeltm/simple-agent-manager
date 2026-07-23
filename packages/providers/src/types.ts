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

export type VolumeStatus =
  | 'creating'
  | 'available'
  | 'attaching'
  | 'attached'
  | 'detaching'
  | 'resizing'
  | 'deleting'
  | 'unknown';

export const SAM_VOLUME_FILESYSTEM_FORMAT = 'ext4';
export const SAM_VOLUME_MOUNT_PATH_TEMPLATE = '/mnt/sam-env-{environmentId}/';
export const SAM_VOLUME_FSTAB_OPTIONS = ['nofail'] as const;

/**
 * Volume conventions consumed by future cloud-init/agent code.
 * The provider layer creates provider block devices only; node-side mkfs,
 * mount, fstab, and "refuse if unmounted" enforcement are intentionally
 * handled outside this package.
 */
export interface VolumeLifecycleConventions {
  /** Filesystem SAM expects for app data volumes. */
  readonly filesystem: typeof SAM_VOLUME_FILESYSTEM_FORMAT;
  /** Mount path template where `{environmentId}` is replaced by the environment ID. */
  readonly mountPathTemplate: typeof SAM_VOLUME_MOUNT_PATH_TEMPLATE;
  /** Required fstab options for resilient boot when the volume is detached. */
  readonly fstabOptions: readonly (typeof SAM_VOLUME_FSTAB_OPTIONS)[number][];
}

export interface VolumeCapabilities {
  /** Whether this provider implementation supports first-class block volumes. */
  readonly supported: boolean;
  /** Minimum provider volume size in GB, if known. */
  readonly minSizeGb?: number;
  /** Maximum provider volume size in GB, if known. */
  readonly maxSizeGb?: number;
  /** True when provider resizing can only increase size. */
  readonly growOnlyResize: boolean;
  /** True when the volume and server must be in the same location/zone. */
  readonly requiresSameLocation: boolean;
  /** Maximum attached volumes per server, if known. */
  readonly maxAttachedVolumesPerServer?: number;
  /** Default filesystem format SAM asks the provider to create when supported. */
  readonly defaultFormat: typeof SAM_VOLUME_FILESYSTEM_FORMAT;
  /** Node-side lifecycle conventions for future cloud-init/agent consumers. */
  readonly lifecycle: VolumeLifecycleConventions;
  /** Known provider support notes or gaps callers may display/log. */
  readonly notes?: readonly string[];
}

export interface VolumeConfig {
  /** Provider volume name. */
  name: string;
  /** Requested size in GB. */
  sizeGb: number;
  /** Provider datacenter/zone. Must match the future server location. */
  location: string;
  /** Metadata labels/tags for the volume. */
  labels?: Record<string, string>;
  /** Filesystem format requested at creation. Defaults to ext4. */
  format?: typeof SAM_VOLUME_FILESYSTEM_FORMAT;
}

export interface VolumeAttachmentConfig {
  /** Provider-specific volume ID. */
  volumeId: string;
  /** Provider-specific server/instance ID. */
  serverId: string;
  /** Provider datacenter/zone shared by volume and server. */
  location: string;
}

export interface VolumeDetachConfig {
  /** Provider-specific volume ID. */
  volumeId: string;
  /** Provider-specific server/instance ID, required by providers that detach via server action. */
  serverId?: string;
  /** Provider datacenter/zone shared by volume and server. */
  location: string;
}

export interface VolumeResizeConfig {
  /** Provider-specific volume ID. */
  volumeId: string;
  /** Provider datacenter/zone where the volume exists. */
  location: string;
  /** New desired size in GB. Must not be smaller than current size. */
  sizeGb: number;
  /** Current size in GB, when caller already has it. Provider fetches when omitted. */
  currentSizeGb?: number;
}

export interface VolumeLookupConfig {
  /** Provider-specific volume ID. */
  volumeId: string;
  /** Provider datacenter/zone where the volume exists. */
  location: string;
}

export interface VolumeListConfig {
  /** Provider datacenter/zone to list. */
  location: string;
  /** Optional provider label/tag filtering. */
  labels?: Record<string, string>;
}

export interface VolumeInstance {
  /** Provider-specific volume ID. */
  id: string;
  /** Provider volume name. */
  name: string;
  /** Volume size in GB. */
  sizeGb: number;
  /** Provider datacenter/zone where the volume exists. */
  location: string;
  /** Normalized provider status. */
  status: VolumeStatus;
  /** Attached provider server/instance ID, if any. */
  attachedServerId?: string;
  /** Linux device path reported by provider after attach, if any. */
  linuxDevice?: string;
  /** Provider volume type/class, if exposed. */
  volumeType?: string;
  /** Provider-reported creation timestamp. */
  createdAt: string;
  /** Metadata labels/tags attached to the volume. */
  labels: Record<string, string>;
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

  /** Provider volume constraints and SAM lifecycle conventions. */
  readonly volumeCapabilities: VolumeCapabilities;

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

  /** Create a provider block volume. */
  createVolume(config: VolumeConfig): Promise<VolumeInstance>;

  /** Attach a volume to a server in the same location/zone. */
  attachVolume(config: VolumeAttachmentConfig): Promise<VolumeInstance>;

  /** Detach a volume from its server. MUST be idempotent on already-detached 404s where provider allows it. */
  detachVolume(config: VolumeDetachConfig): Promise<VolumeInstance | null>;

  /** Resize a volume upward only. Implementations MUST reject shrink requests before API calls. */
  resizeVolume(config: VolumeResizeConfig): Promise<VolumeInstance>;

  /** Delete a volume. MUST be idempotent (no error on 404). */
  deleteVolume(config: VolumeLookupConfig): Promise<void>;

  /** Get volume by ID. Returns null if not found (no throw). */
  getVolume(config: VolumeLookupConfig): Promise<VolumeInstance | null>;

  /** List volumes in an explicit location/zone with optional label-based filtering. */
  listVolumes(config: VolumeListConfig): Promise<VolumeInstance[]>;
}

/**
 * Provider configuration — discriminated union per provider type.
 * Accepts explicit credentials; MUST NOT access process.env.
 */
export type ProviderConfig =
  | HetznerProviderConfig
  | ScalewayProviderConfig
  | GcpProviderConfig
  | VultrProviderConfig;

export interface HetznerProviderConfig {
  provider: 'hetzner';
  apiToken: string;
  datacenter?: string;
  /** Optional provider logger. Defaults to no-op and must not receive secrets. */
  logger?: ProviderLogger;
  /** Delay in ms before retrying same location on 412 (default: 3000) */
  placementRetryDelayMs?: number;
  /** Whether to try other locations after primary fails (default: true) */
  placementFallbackEnabled?: boolean;
  /** Initial delay in ms for capacity retry backoff (default: 15000) */
  capacityRetryInitialDelayMs?: number;
  /** Maximum delay in ms per capacity retry wait (default: 120000) */
  capacityRetryMaxDelayMs?: number;
  /** Maximum number of capacity retry attempts before giving up (default: 10) */
  capacityRetryMaxAttempts?: number;
  /** Total time budget in ms for capacity retries (default: 300000 = 5 min) */
  capacityRetryBudgetMs?: number;
}

export interface ScalewayProviderConfig {
  provider: 'scaleway';
  secretKey: string;
  projectId: string;
  zone?: string;
}

export interface VultrProviderConfig {
  provider: 'vultr';
  apiToken: string;
  /** Default region (Vultr region id, e.g. `fra`). Defaults to DEFAULT_VULTR_REGION. */
  region?: string;
  /** OS name matched against `GET /v2/os` to resolve the numeric os_id. Defaults to DEFAULT_VULTR_OS_NAME. */
  osName?: string;
  /** Per-request timeout in ms. Default from getTimeoutMs(). */
  requestTimeoutMs?: number;
  /** Total budget in ms for the post-create main_ip poll (default DEFAULT_VULTR_IP_POLL_TIMEOUT_MS). */
  ipPollTimeoutMs?: number;
  /** Delay in ms between main_ip poll attempts (default DEFAULT_VULTR_IP_POLL_INTERVAL_MS). */
  ipPollIntervalMs?: number;
  /** Optional provider logger. Defaults to no-op and must not receive secrets. */
  logger?: ProviderLogger;
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
  /** Source CIDR ranges allowed by the GCP VPC firewall rule for VM agent ingress. */
  firewallSourceRanges?: readonly string[];
  /** TCP ports allowed by the GCP VPC firewall rule for VM agent ingress. */
  agentPorts?: readonly string[];
  /** Source CIDR ranges allowed by the GCP VPC firewall rule for public app-route ingress. */
  appRouteSourceRanges?: readonly string[];
  /** TCP ports allowed by the GCP VPC firewall rule for public app-route ingress. */
  appRoutePorts?: readonly string[];
}

/**
 * Normalized error categories for provider operations.
 * Each provider maps its own native error codes/signals to these categories.
 * The retry engine consumes only the normalized category.
 */
export type ProviderErrorCategory =
  | 'transient_capacity'
  | 'quota_exceeded'
  | 'invalid_config'
  | 'rate_limited'
  | 'auth_error'
  | 'unknown';

export type ProviderErrorContextValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | ProviderErrorContext
  | ProviderErrorContextValue[];

export interface ProviderErrorContext {
  [key: string]: ProviderErrorContextValue;
}

export interface ProviderLogContext {
  [key: string]: string | number | boolean | null | undefined;
}

export interface ProviderLogger {
  warn(message: string, context?: ProviderLogContext): void;
  info(message: string, context?: ProviderLogContext): void;
}

export const noopProviderLogger: ProviderLogger = {
  warn: () => {},
  info: () => {},
};

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
    /** Original error and safe structured diagnostics */
    options?: {
      cause?: Error;
      context?: ProviderErrorContext;
      /** Raw error code from the provider API (e.g., Hetzner's "resource_unavailable") */
      providerCode?: string;
      /** Normalized error category for retry decisions */
      category?: ProviderErrorCategory;
    },
  ) {
    super(message, options);
    this.context = options?.context;
    this.providerCode = options?.providerCode;
    this.category = options?.category ?? 'unknown';
  }

  readonly context: ProviderErrorContext | undefined;

  /** Raw error code from the provider API response */
  readonly providerCode: string | undefined;

  /** Normalized error category for provider-agnostic retry decisions */
  readonly category: ProviderErrorCategory;

  /** Make Error properties visible to JSON.stringify */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      provider: this.providerName,
      statusCode: this.statusCode,
      providerCode: this.providerCode,
      category: this.category,
      cause: this.cause instanceof Error ? this.cause.message : this.cause,
      context: this.context,
    };
  }
}
