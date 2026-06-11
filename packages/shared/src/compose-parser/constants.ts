/**
 * Compose Parser Constants
 *
 * Allowlist and denylist of Compose fields with per-field error messages.
 * Posture: DEFAULT-DENY — any field not in the allowlist is rejected.
 */

// =============================================================================
// Top-level Compose allowlist
// =============================================================================

/** Top-level Compose keys that the parser accepts. */
export const TOP_LEVEL_ALLOWED = new Set([
  'services',
  'volumes',
  // x-sam-* extensions
  'x-sam-routes',
  'x-sam-pre-flight',
]);

/**
 * Top-level keys that are silently skipped (informational, not behavioral).
 * These are standard Compose metadata fields that have no effect on the
 * deployment manifest.
 */
export const TOP_LEVEL_IGNORED = new Set([
  'name',
  'version', // Compose v2 version field (not the manifest version)
]);

// =============================================================================
// Service-level Compose allowlist
// =============================================================================

/** Service-level Compose keys that the parser accepts. */
export const SERVICE_ALLOWED = new Set([
  'image',
  'command',
  'entrypoint',
  'environment',
  'volumes',
  'depends_on',
  'restart',
  'healthcheck',
  'deploy',
  'expose',
  'ports',
  'container_name', // silently ignored, informational
]);

// =============================================================================
// Denylist — fields rejected with explicit, friendly errors
// =============================================================================

export const DENIED_SERVICE_FIELDS: Record<string, string> = {
  build:
    'Images must be prebuilt and pushed to a registry. The "build" field is not allowed — use a prebuilt image reference instead.',
  privileged: 'Privileged containers are not allowed. Remove the "privileged" field.',
  cap_add: 'Adding Linux capabilities is not allowed. Remove the "cap_add" field.',
  cap_drop:
    'Capability management is not allowed in the Compose subset. Remove the "cap_drop" field.',
  network_mode:
    'Custom network modes (e.g., host networking) are not allowed. All services share one private network.',
  devices: 'Device access is not allowed. Remove the "devices" field.',
  security_opt: 'Security options are not allowed. Remove the "security_opt" field.',
  sysctls: 'Kernel parameter tuning is not allowed. Remove the "sysctls" field.',
  ulimits: 'ulimits configuration is not allowed. Remove the "ulimits" field.',
  pid: 'PID namespace sharing is not allowed. Remove the "pid" field.',
  ipc: 'IPC namespace sharing is not allowed. Remove the "ipc" field.',
  extends:
    'The "extends" field is not supported. Define each service inline in a single Compose file.',
  env_file:
    'The "env_file" field is not allowed. Use "environment" with plain values or { x-sam-secret: "name" } references.',
  runtime: 'Custom container runtimes are not allowed. Remove the "runtime" field.',
  stdin_open: 'Interactive mode (stdin_open) is not supported for deployed services.',
  tty: 'TTY allocation is not supported for deployed services.',
  user: 'The "user" field is not allowed. Container user is managed by SAM.',
  working_dir:
    'The "working_dir" field is not allowed. Use the working directory set in the image.',
  domainname: 'The "domainname" field is not allowed. DNS is managed by SAM.',
  hostname: 'The "hostname" field is not allowed. Hostnames are managed by SAM.',
  extra_hosts: 'The "extra_hosts" field is not allowed.',
  dns: 'The "dns" field is not allowed. DNS is managed by SAM.',
  dns_search: 'The "dns_search" field is not allowed. DNS is managed by SAM.',
  tmpfs: 'The "tmpfs" field is not allowed.',
  shm_size: 'The "shm_size" field is not allowed.',
  logging: 'The "logging" field is not allowed. Log configuration is managed by SAM.',
  stop_signal: 'The "stop_signal" field is not allowed.',
  stop_grace_period: 'The "stop_grace_period" field is not allowed.',
  external_links: 'The "external_links" field is not allowed.',
  links: 'The "links" field is not allowed. Use depends_on for service ordering.',
  configs: 'The "configs" field is not allowed. Use environment variables or volumes.',
  secrets:
    'The Compose "secrets" field is not allowed. Use environment variables with { x-sam-secret: "name" } instead.',
  labels: 'The "labels" field is not allowed. Container labels are managed by SAM.',
};

export const DENIED_TOP_LEVEL_FIELDS: Record<string, string> = {
  networks:
    'Custom network configuration is not allowed. All services share one private network per environment.',
  configs: 'The top-level "configs" field is not allowed.',
  secrets:
    'The top-level "secrets" field is not allowed. Use environment variables with { x-sam-secret: "name" } references.',
  extensions: 'The "extensions" field is not recognized. Use x-sam-* prefixed extensions.',
};

// =============================================================================
// Docker socket / dangerous volume patterns
// =============================================================================

export const DOCKER_SOCKET_PATHS = ['/var/run/docker.sock', '/run/docker.sock'];

// =============================================================================
// Parser defaults — exported so callers can override via env vars
// =============================================================================

export const DEFAULT_PRE_FLIGHT_TIMEOUT_SECONDS = 300;
export const MAX_PRE_FLIGHT_TIMEOUT_SECONDS = 3600;
export const DEFAULT_SERVICE_MEMORY_LIMIT_MB = 512;
export const DEFAULT_SERVICE_CPU_LIMIT = 1;
