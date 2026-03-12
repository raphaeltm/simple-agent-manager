/**
 * Provider Interface Contract
 *
 * This file defines the target TypeScript interfaces for the provider package.
 * It serves as the contract specification — the actual implementation lives in
 * packages/providers/src/types.ts.
 */

import type { VMSize } from '@simple-agent-manager/shared';

// ---------------------------------------------------------------------------
// Value Objects
// ---------------------------------------------------------------------------

/** Configuration for creating a VM. Contains NO secrets. */
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

/** Representation of a provisioned VM */
export interface VMInstance {
  /** Provider-specific server ID */
  id: string;
  /** Server name */
  name: string;
  /** Public IPv4 address */
  ip: string;
  /** Current status */
  status: VMStatus;
  /** Provider-specific server type (e.g., 'cx23') */
  serverType: string;
  /** ISO 8601 creation timestamp */
  createdAt: string;
  /** Metadata labels */
  labels: Record<string, string>;
}

export type VMStatus = 'initializing' | 'running' | 'off' | 'starting' | 'stopping';

/** Provider-specific size tier configuration */
export interface SizeConfig {
  /** Provider-specific server type identifier */
  type: string;
  /** Human-readable price string */
  price: string;
  /** Virtual CPU count */
  vcpu: number;
  /** RAM in gigabytes */
  ramGb: number;
  /** Storage in gigabytes */
  storageGb: number;
}

// ---------------------------------------------------------------------------
// Provider Interface
// ---------------------------------------------------------------------------

/** Cloud infrastructure provider abstraction */
export interface Provider {
  /** Provider identifier matching CredentialProvider type */
  readonly name: string;
  /** Available datacenter/region identifiers */
  readonly locations: readonly string[];
  /** Available VM size configurations */
  readonly sizes: Readonly<Record<VMSize, SizeConfig>>;

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
  /** Validate provider credentials. Returns true if valid, throws on failure. */
  validateToken(): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Provider Configuration (Discriminated Union)
// ---------------------------------------------------------------------------

export type ProviderConfig =
  | HetznerProviderConfig
  | UpCloudProviderConfig;

export interface HetznerProviderConfig {
  provider: 'hetzner';
  apiToken: string;
  datacenter?: string;
}

export interface UpCloudProviderConfig {
  provider: 'upcloud';
  username: string;
  password: string;
}

// ---------------------------------------------------------------------------
// Error Type
// ---------------------------------------------------------------------------

/** Normalized error for all provider operations */
export class ProviderError extends Error {
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
    this.name = 'ProviderError';
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a provider instance from explicit configuration.
 * MUST NOT access process.env or any Node.js-only APIs.
 */
export declare function createProvider(config: ProviderConfig): Provider;
