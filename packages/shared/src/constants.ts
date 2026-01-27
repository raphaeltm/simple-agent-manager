import type { VMSize, VMLocation } from './types';

// =============================================================================
// VM Size Configuration
// =============================================================================
export const VM_SIZE_CONFIG: Record<VMSize, { hetznerType: string; cpus: number; ram: string }> = {
  small: { hetznerType: 'cx22', cpus: 2, ram: '4GB' },
  medium: { hetznerType: 'cx32', cpus: 4, ram: '8GB' },
  large: { hetznerType: 'cx42', cpus: 8, ram: '16GB' },
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
// Limits
// =============================================================================
export const MAX_WORKSPACES_PER_USER = 10;
export const IDLE_TIMEOUT_SECONDS = 30 * 60; // 30 minutes
export const IDLE_WARNING_SECONDS = 25 * 60; // 25 minutes (5 min before shutdown)
export const WORKSPACE_NAME_MAX_LENGTH = 64;

// =============================================================================
// URLs
// =============================================================================
export const GITHUB_APP_INSTALL_URL = 'https://github.com/apps/your-app-name/installations/new';

// =============================================================================
// Hetzner Image
// =============================================================================
export const HETZNER_IMAGE = 'ubuntu-24.04';
