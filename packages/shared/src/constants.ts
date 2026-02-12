import type { VMSize, VMLocation } from './types';

// =============================================================================
// VM Size Configuration
// =============================================================================
export const VM_SIZE_CONFIG: Record<VMSize, { hetznerType: string; cpus: number; ram: string }> = {
  small: { hetznerType: 'cx23', cpus: 2, ram: '4GB' },
  medium: { hetznerType: 'cx33', cpus: 4, ram: '8GB' },
  large: { hetznerType: 'cx43', cpus: 8, ram: '16GB' },
};

// =============================================================================
// VM Location Configuration
// =============================================================================
export const VM_LOCATIONS: Record<VMLocation, { name: string; country: string }> = {
  nbg1: { name: 'Nuremberg', country: 'DE' },
  fsn1: { name: 'Falkenstein', country: 'DE' },
  hel1: { name: 'Helsinki', country: 'FI' },
};

// =============================================================================
// Status Configuration
// =============================================================================
export const STATUS_LABELS: Record<string, string> = {
  pending: 'Pending',
  creating: 'Creating',
  running: 'Running',
  stopping: 'Stopping',
  stopped: 'Stopped',
  error: 'Error',
};

export const STATUS_COLORS: Record<string, string> = {
  pending: 'gray',
  creating: 'blue',
  running: 'green',
  stopping: 'yellow',
  stopped: 'gray',
  error: 'red',
};

// =============================================================================
// Defaults
// =============================================================================
export const DEFAULT_VM_SIZE: VMSize = 'medium';
export const DEFAULT_VM_LOCATION: VMLocation = 'nbg1';
export const DEFAULT_BRANCH = 'main';

// =============================================================================
// Default Limits (configurable via environment variables)
// Per constitution principle XI: all values must be configurable
// =============================================================================

/** Default max workspaces per user. Override via MAX_WORKSPACES_PER_USER env var. */
export const DEFAULT_MAX_WORKSPACES_PER_USER = 10;

/** Backwards compatibility alias - use DEFAULT_MAX_WORKSPACES_PER_USER */
export const MAX_WORKSPACES_PER_USER = DEFAULT_MAX_WORKSPACES_PER_USER;

/** Default max nodes per user. Override via MAX_NODES_PER_USER env var. */
export const DEFAULT_MAX_NODES_PER_USER = 10;

/** Default max workspaces per node. Override via MAX_WORKSPACES_PER_NODE env var. */
export const DEFAULT_MAX_WORKSPACES_PER_NODE = 10;

/** Default max agent sessions per workspace. Override via MAX_AGENT_SESSIONS_PER_WORKSPACE env var. */
export const DEFAULT_MAX_AGENT_SESSIONS_PER_WORKSPACE = 10;

/** Default node heartbeat staleness threshold in seconds. Override via NODE_HEARTBEAT_STALE_SECONDS env var. */
export const DEFAULT_NODE_HEARTBEAT_STALE_SECONDS = 180;

/** Default idle timeout in seconds (30 minutes). Override via IDLE_TIMEOUT_SECONDS env var. */
export const DEFAULT_IDLE_TIMEOUT_SECONDS = 30 * 60;

/** Default idle warning threshold (5 minutes before shutdown). */
export const DEFAULT_IDLE_WARNING_SECONDS = 25 * 60;

/** Maximum workspace name length. */
export const WORKSPACE_NAME_MAX_LENGTH = 64;

// =============================================================================
// Hetzner Configuration
// =============================================================================

/** Default Hetzner image. Override via HETZNER_IMAGE env var. */
export const DEFAULT_HETZNER_IMAGE = 'ubuntu-24.04';

/** Backwards compatibility alias - use DEFAULT_HETZNER_IMAGE */
export const HETZNER_IMAGE = DEFAULT_HETZNER_IMAGE;

// Note: GitHub App install URL is NOT provided as a constant.
// It must be derived from the actual GitHub App configuration at runtime.
// Format: https://github.com/apps/{app-slug}/installations/new
