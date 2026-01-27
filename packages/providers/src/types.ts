import type { VMSize } from '@cloud-ai-workspaces/shared';

/**
 * Configuration for creating a VM
 *
 * Note: anthropicApiKey is NOT included.
 * Users authenticate via `claude login` in CloudCLI terminal.
 * ANTHROPIC_API_KEY env var must NOT be set on VMs.
 */
export interface VMConfig {
  /** Unique identifier for the workspace */
  workspaceId: string;

  /** Human-readable name */
  name: string;

  /** Git repository URL */
  repoUrl: string;

  /** VM size tier */
  size: VMSize;

  /** Auto-generated basic auth password */
  authPassword: string;

  /** API token for cleanup callback */
  apiToken: string;

  /** Base domain for DNS */
  baseDomain: string;

  /** API URL for cleanup callback */
  apiUrl: string;

  /** GitHub installation token for private repos (optional) */
  githubToken?: string;
}

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
  status: 'initializing' | 'running' | 'off' | 'starting' | 'stopping';

  /** Server type (e.g., "cx22") */
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

/**
 * Result of executing a command in a workspace
 */
export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Cloud provider interface
 */
export interface Provider {
  /** Provider identifier */
  readonly name: string;

  /** Create a new VM */
  createVM(config: VMConfig): Promise<VMInstance>;

  /** Delete a VM by ID */
  deleteVM(id: string): Promise<void>;

  /** List all managed VMs */
  listVMs(): Promise<VMInstance[]>;

  /** Get a single VM by ID */
  getVM(id: string): Promise<VMInstance | null>;

  /** Get size configuration */
  getSizeConfig(size: VMSize): SizeConfig;

  /** Generate cloud-init script */
  generateCloudInit(config: VMConfig): string;

  /** Execute a command in a workspace (optional, not all providers support this) */
  exec?(workspaceId: string, command: string): Promise<ExecResult>;
}

/**
 * Provider configuration
 */
export interface ProviderConfig {
  /** API token for the provider */
  apiToken: string;

  /** Default datacenter/region */
  datacenter?: string;
}
