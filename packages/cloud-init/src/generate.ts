import { CLOUD_INIT_TEMPLATE } from './template';

// --- Validation patterns for shell-embedded variables ---

/** Alphanumeric, hyphens, underscores (IDs like nodeId, projectId, etc.) */
const SAFE_ID_RE = /^[a-zA-Z0-9_-]+$/;

/** Valid hostname: alphanumeric, hyphens, dots */
const SAFE_HOSTNAME_RE = /^[a-zA-Z0-9.-]+$/;

/** Numeric positive integer */
const NUMERIC_RE = /^[0-9]+$/;

/** journald size values: digits + optional K/M/G/T suffix */
const JOURNALD_SIZE_RE = /^[0-9]+[KMGT]?$/;

/** journald time span: digits + time unit */
const JOURNALD_TIME_RE = /^[0-9]+(us|ms|s|min|h|day|week|month|year)$/;

/** URL must start with https:// and contain only safe characters.
 * Excludes $ (systemd variable expansion) and ' (shell quoting risk). */
const SAFE_URL_RE = /^https:\/\/[a-zA-Z0-9._~:/?#[\]@!&()*+,;=-]+$/;

/** callbackToken: JWT format (base64url segments separated by dots) */
const SAFE_TOKEN_RE = /^[a-zA-Z0-9_.\-/+=]+$/;

/** Boolean strings accepted by the VM agent config loader. */
const BOOLEAN_RE = /^(true|false)$/;

/** Simple email syntax for ACME account contact, excluding whitespace/control chars. */
const SAFE_EMAIL_RE = /^[a-zA-Z0-9.!#$%&*+/=?^_`{|}~-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

/** Deployment compose command: executable plus optional space-separated args, no shell metacharacters. */
const SAFE_DEPLOY_COMPOSE_CMD_RE = /^[a-zA-Z0-9_./:-]+(?: [a-zA-Z0-9_./:-]+)*$/;

/** Go duration syntax accepted for deployment health timeout (e.g. 5m, 1m30s). */
const GO_DURATION_RE = /^(?:[0-9]+(?:ns|us|ms|s|m|h))+$/;

/**
 * Validate all CloudInitVariables before they are embedded into shell/YAML.
 * Throws an error describing the first invalid field found.
 */
export function validateCloudInitVariables(variables: CloudInitVariables): void {
  const errors: string[] = [];

  // Required fields
  if (!variables.nodeId || !SAFE_ID_RE.test(variables.nodeId)) {
    errors.push(`nodeId: must match ${SAFE_ID_RE} (got ${JSON.stringify(variables.nodeId)})`);
  }
  if (!variables.hostname || !SAFE_HOSTNAME_RE.test(variables.hostname)) {
    errors.push(
      `hostname: must match ${SAFE_HOSTNAME_RE} (got ${JSON.stringify(variables.hostname)})`
    );
  }
  if (!variables.controlPlaneUrl || !SAFE_URL_RE.test(variables.controlPlaneUrl)) {
    errors.push(
      `controlPlaneUrl: must be a valid HTTPS URL (got ${JSON.stringify(variables.controlPlaneUrl)})`
    );
  }
  if (!variables.jwksUrl || !SAFE_URL_RE.test(variables.jwksUrl)) {
    errors.push(`jwksUrl: must be a valid HTTPS URL (got ${JSON.stringify(variables.jwksUrl)})`);
  }
  if (!variables.callbackToken || !SAFE_TOKEN_RE.test(variables.callbackToken)) {
    errors.push(
      `callbackToken: must contain only safe token characters (got ${JSON.stringify(variables.callbackToken)})`
    );
  }

  // Optional fields — only validated when present and non-empty
  if (variables.vmAgentPort !== undefined && variables.vmAgentPort !== '') {
    const port = Number(variables.vmAgentPort);
    if (!NUMERIC_RE.test(variables.vmAgentPort) || port < 1 || port > 65535) {
      errors.push(
        `vmAgentPort: must be numeric 1-65535 (got ${JSON.stringify(variables.vmAgentPort)})`
      );
    }
  }
  if (variables.cfIpFetchTimeout !== undefined && variables.cfIpFetchTimeout !== '') {
    const timeout = Number(variables.cfIpFetchTimeout);
    if (!NUMERIC_RE.test(variables.cfIpFetchTimeout) || timeout < 1) {
      errors.push(
        `cfIpFetchTimeout: must be a positive integer (got ${JSON.stringify(variables.cfIpFetchTimeout)})`
      );
    }
  }
  if (variables.projectId !== undefined && variables.projectId !== '') {
    if (!SAFE_ID_RE.test(variables.projectId)) {
      errors.push(
        `projectId: must match ${SAFE_ID_RE} (got ${JSON.stringify(variables.projectId)})`
      );
    }
  }
  if (variables.chatSessionId !== undefined && variables.chatSessionId !== '') {
    if (!SAFE_ID_RE.test(variables.chatSessionId)) {
      errors.push(
        `chatSessionId: must match ${SAFE_ID_RE} (got ${JSON.stringify(variables.chatSessionId)})`
      );
    }
  }
  if (variables.taskId !== undefined && variables.taskId !== '') {
    if (!SAFE_ID_RE.test(variables.taskId)) {
      errors.push(`taskId: must match ${SAFE_ID_RE} (got ${JSON.stringify(variables.taskId)})`);
    }
  }
  if (variables.taskMode !== undefined && variables.taskMode !== '') {
    if (variables.taskMode !== 'task' && variables.taskMode !== 'conversation') {
      errors.push(
        `taskMode: must be 'task' or 'conversation' (got ${JSON.stringify(variables.taskMode)})`
      );
    }
  }
  if (variables.provider !== undefined && variables.provider !== '') {
    if (!VALID_CLOUD_PROVIDERS.includes(variables.provider as CloudProvider)) {
      errors.push(
        `provider: must be one of ${VALID_CLOUD_PROVIDERS.join(', ')} (got ${JSON.stringify(variables.provider)})`
      );
    }
  }
  if (variables.logJournalMaxUse !== undefined && variables.logJournalMaxUse !== '') {
    if (!JOURNALD_SIZE_RE.test(variables.logJournalMaxUse)) {
      errors.push(
        `logJournalMaxUse: must match ${JOURNALD_SIZE_RE} (got ${JSON.stringify(variables.logJournalMaxUse)})`
      );
    }
  }
  if (variables.logJournalKeepFree !== undefined && variables.logJournalKeepFree !== '') {
    if (!JOURNALD_SIZE_RE.test(variables.logJournalKeepFree)) {
      errors.push(
        `logJournalKeepFree: must match ${JOURNALD_SIZE_RE} (got ${JSON.stringify(variables.logJournalKeepFree)})`
      );
    }
  }
  if (variables.logJournalMaxRetention !== undefined && variables.logJournalMaxRetention !== '') {
    if (!JOURNALD_TIME_RE.test(variables.logJournalMaxRetention)) {
      errors.push(
        `logJournalMaxRetention: must match ${JOURNALD_TIME_RE} (got ${JSON.stringify(variables.logJournalMaxRetention)})`
      );
    }
  }
  if (variables.dockerDnsServers !== undefined && variables.dockerDnsServers !== '') {
    if (!isValidDockerDnsServers(variables.dockerDnsServers)) {
      errors.push(
        `dockerDnsServers: must be a JSON fragment containing valid quoted IPv4 addresses (got ${JSON.stringify(variables.dockerDnsServers)})`
      );
    }
  }
  if (
    variables.devcontainerCacheEnabled !== undefined &&
    variables.devcontainerCacheEnabled !== ''
  ) {
    if (!BOOLEAN_RE.test(variables.devcontainerCacheEnabled)) {
      errors.push(
        `devcontainerCacheEnabled: must be "true" or "false" (got ${JSON.stringify(variables.devcontainerCacheEnabled)})`
      );
    }
  }
  if (variables.originCaCertificateUrl !== undefined && variables.originCaCertificateUrl !== '') {
    if (!SAFE_URL_RE.test(variables.originCaCertificateUrl)) {
      errors.push(
        `originCaCertificateUrl: must be a valid HTTPS URL (got ${JSON.stringify(variables.originCaCertificateUrl)})`
      );
    }
  }
  if (variables.swapSizeMb !== undefined && variables.swapSizeMb !== '') {
    const size = Number(variables.swapSizeMb);
    if (!NUMERIC_RE.test(variables.swapSizeMb) || size < 0 || size > 65536) {
      errors.push(
        `swapSizeMb: must be numeric 0-65536 (got ${JSON.stringify(variables.swapSizeMb)})`
      );
    }
  }
  if (variables.swapSwappiness !== undefined && variables.swapSwappiness !== '') {
    const val = Number(variables.swapSwappiness);
    if (!NUMERIC_RE.test(variables.swapSwappiness) || val < 0 || val > 100) {
      errors.push(
        `swapSwappiness: must be numeric 0-100 (got ${JSON.stringify(variables.swapSwappiness)})`
      );
    }
  }
  if (variables.role !== undefined && variables.role !== '') {
    if (variables.role !== 'workspace' && variables.role !== 'deployment') {
      errors.push(
        `role: must be 'workspace' or 'deployment' (got ${JSON.stringify(variables.role)})`
      );
    }
  }
  if (variables.environmentId !== undefined && variables.environmentId !== '') {
    if (!SAFE_ID_RE.test(variables.environmentId)) {
      errors.push(
        `environmentId: must match ${SAFE_ID_RE} (got ${JSON.stringify(variables.environmentId)})`
      );
    }
  }
  if (variables.deploySigningPubKey !== undefined && variables.deploySigningPubKey !== '') {
    if (!SAFE_TOKEN_RE.test(variables.deploySigningPubKey)) {
      errors.push(
        `deploySigningPubKey: must contain only safe token characters (got ${JSON.stringify(variables.deploySigningPubKey)})`
      );
    }
  }
  if (variables.deployAcmeEmail !== undefined && variables.deployAcmeEmail !== '') {
    if (!SAFE_EMAIL_RE.test(variables.deployAcmeEmail)) {
      errors.push(
        `deployAcmeEmail: must be a valid email address (got ${JSON.stringify(variables.deployAcmeEmail)})`
      );
    }
  }
  if (variables.deployAcmeCa !== undefined && variables.deployAcmeCa !== '') {
    if (!SAFE_URL_RE.test(variables.deployAcmeCa)) {
      errors.push(
        `deployAcmeCa: must be a valid HTTPS URL (got ${JSON.stringify(variables.deployAcmeCa)})`
      );
    }
  }
  if (variables.deployComposeCmd !== undefined && variables.deployComposeCmd !== '') {
    if (!SAFE_DEPLOY_COMPOSE_CMD_RE.test(variables.deployComposeCmd)) {
      errors.push(
        `deployComposeCmd: must be a command plus optional arguments without shell metacharacters (got ${JSON.stringify(variables.deployComposeCmd)})`
      );
    }
  }
  if (variables.deployHealthTimeout !== undefined && variables.deployHealthTimeout !== '') {
    if (!GO_DURATION_RE.test(variables.deployHealthTimeout)) {
      errors.push(
        `deployHealthTimeout: must be a Go duration using ns/us/ms/s/m/h units (got ${JSON.stringify(variables.deployHealthTimeout)})`
      );
    }
  }

  if (errors.length > 0) {
    throw new Error(`Cloud-init variable validation failed:\n${errors.join('\n')}`);
  }
}

/** Valid cloud provider values for cloud-init. */
export const VALID_CLOUD_PROVIDERS = ['hetzner', 'scaleway', 'gcp', 'vultr'] as const;
export type CloudProvider = (typeof VALID_CLOUD_PROVIDERS)[number];

/**
 * Variables for cloud-init generation.
 */
export interface CloudInitVariables {
  nodeId: string;
  hostname: string;
  controlPlaneUrl: string;
  jwksUrl: string;
  callbackToken: string;
  /** Cloud provider (hetzner, scaleway, gcp, vultr). Used for provider-specific apt mirrors. */
  provider?: string;
  /** journald SystemMaxUse (default: 500M) */
  logJournalMaxUse?: string;
  /** journald SystemKeepFree (default: 1G) */
  logJournalKeepFree?: string;
  /** journald MaxRetentionSec (default: 7day) */
  logJournalMaxRetention?: string;
  /** Project ID for message persistence (nullable — omitted for standalone workspaces) */
  projectId?: string;
  /** Pre-created chat session ID (nullable — omitted for standalone workspaces) */
  chatSessionId?: string;
  /** Task ID for task-driven workspaces (nullable — omitted for interactive workspaces) */
  taskId?: string;
  /** Task execution mode: 'task' (default) or 'conversation' */
  taskMode?: string;
  /** Docker daemon DNS servers as JSON array content (default: "1.1.1.1", "8.8.8.8") */
  dockerDnsServers?: string;
  /** Node-scoped endpoint used at boot to sign a locally generated Origin CA CSR. */
  originCaCertificateUrl?: string;
  /** VM agent port override (default: 8443 with TLS, 8080 without) */
  vmAgentPort?: string;
  /** Timeout in seconds for fetching Cloudflare IP ranges at boot (default: 10) */
  cfIpFetchTimeout?: string;
  /** Enable opportunistic devcontainer image caching via GHCR (default: false) */
  devcontainerCacheEnabled?: string;
  /** Swap file size in MB (default: 2048). Set to "0" to disable swap. */
  swapSizeMb?: string;
  /** Swap swappiness value 0-100 (default: 60). Only relevant when swap is enabled. */
  swapSwappiness?: string;
  /** VM agent role: 'workspace' (default) or 'deployment'. */
  role?: string;
  /** Deployment environment ID (required when role='deployment'). */
  environmentId?: string;
  /** Base64-encoded Ed25519 deploy signing public key for release verification. */
  deploySigningPubKey?: string;
  /** Contact email for ACME/Let's Encrypt account on deployment nodes. */
  deployAcmeEmail?: string;
  /** Optional ACME CA directory URL override for deployment nodes. */
  deployAcmeCa?: string;
  /** Docker Compose command override for deployment nodes. */
  deployComposeCmd?: string;
  /** Max time for deployment health checks, as Go duration string. */
  deployHealthTimeout?: string;
}

/**
 * Options for cloud-init generation.
 */
export interface GenerateCloudInitOptions {
  /** Whether to validate the output size against the 32KB Hetzner limit (default: true) */
  validateSize?: boolean;
}

/**
 * Generate cloud-init configuration from template with variables.
 */
export function generateCloudInit(
  variables: CloudInitVariables,
  options?: GenerateCloudInitOptions
): string {
  validateCloudInitVariables(variables);

  let config = CLOUD_INIT_TEMPLATE;

  const replacements: Record<string, string> = {
    '{{ node_id }}': variables.nodeId,
    '{{ hostname }}': variables.hostname,
    '{{ control_plane_url }}': variables.controlPlaneUrl,
    '{{ jwks_url }}': variables.jwksUrl,
    '{{ callback_token }}': variables.callbackToken,
    '{{ log_journal_max_use }}': variables.logJournalMaxUse ?? '500M',
    '{{ log_journal_keep_free }}': variables.logJournalKeepFree ?? '1G',
    '{{ log_journal_max_retention }}': variables.logJournalMaxRetention ?? '7day',
    '{{ project_id }}': variables.projectId ?? '',
    '{{ chat_session_id }}': variables.chatSessionId ?? '',
    '{{ task_id }}': variables.taskId ?? '',
    '{{ task_mode }}': variables.taskMode ?? 'task',
    '{{ docker_name_tag }}': '{{.Name}}',
    '{{ docker_dns_servers }}': variables.dockerDnsServers ?? '"1.1.1.1", "8.8.8.8"',
    '{{ vm_agent_port }}': variables.vmAgentPort ?? (variables.originCaCertificateUrl ? '8443' : '8080'),
    '{{ tls_cert_path }}': variables.originCaCertificateUrl ? '/etc/sam/tls/origin-ca.pem' : '',
    '{{ tls_key_path }}': variables.originCaCertificateUrl ? '/etc/sam/tls/origin-ca-key.pem' : '',
    '{{ origin_ca_certificate_url }}': variables.originCaCertificateUrl ?? '',
    '{{ cf_ip_fetch_timeout }}': variables.cfIpFetchTimeout ?? '10',
    '{{ provider }}': variables.provider ?? '',
    '{{ devcontainer_cache_enabled }}': variables.devcontainerCacheEnabled ?? 'false',
    '{{ swap_size_mb }}': variables.swapSizeMb ?? '2048',
    '{{ swap_swappiness }}': variables.swapSwappiness ?? '60',
    '{{ role }}': variables.role ?? '',
    '{{ environment_id }}': variables.environmentId ?? '',
    '{{ deploy_signing_pub_key }}': variables.deploySigningPubKey ?? '',
    '{{ deploy_acme_email }}': variables.deployAcmeEmail ?? '',
    '{{ deploy_acme_ca }}': variables.deployAcmeCa ?? '',
    '{{ deploy_compose_cmd }}': variables.deployComposeCmd ?? '',
    '{{ deploy_health_timeout }}': variables.deployHealthTimeout ?? '',
  };

  // Use function replacement to prevent $-pattern interpretation in values.
  // String.prototype.replace() interprets $&, $', $` etc. in string replacements,
  // which corrupts PEM content or other values containing $ characters.
  for (const [placeholder, value] of Object.entries(replacements)) {
    config = config.replace(new RegExp(escapeRegExp(placeholder), 'g'), () => value);
  }

  if (options?.validateSize !== false) {
    if (!validateCloudInitSize(config)) {
      const sizeBytes = new TextEncoder().encode(config).length;
      throw new Error(
        `Cloud-init config exceeds ${HETZNER_USER_DATA_MAX_BYTES / 1024}KB Hetzner user-data limit (${sizeBytes} bytes)`
      );
    }
  }

  return config;
}

/**
 * Indent multi-line content for YAML literal block scalars (`|`).
 *
 * In YAML `|` blocks, the indentation level is set by the first content line.
 * All subsequent lines must maintain at least that indentation, or the block
 * terminates. The template already provides the correct indent for the first
 * line (via the placeholder position), but replacement content after the first
 * newline starts at column 0. This function adds the required padding to every
 * line after the first so the YAML block scalar remains valid.
 */
export function indentForYamlBlock(content: string, indent: number): string {
  if (!content || !content.includes('\n')) return content;
  const pad = ' '.repeat(indent);
  return content
    .split('\n')
    .map((line, i) => (i === 0 ? line : pad + line))
    .join('\n');
}

function isValidDockerDnsServers(value: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(`[${value}]`);
  } catch {
    return false;
  }

  return Array.isArray(parsed) && parsed.length > 0 && parsed.every(isValidIpv4Address);
}

function isValidIpv4Address(value: unknown): boolean {
  if (typeof value !== 'string') return false;

  const octets = value.split('.');
  return (
    octets.length === 4 &&
    octets.every((octet) => {
      if (!/^\d{1,3}$/.test(octet)) return false;
      const numeric = Number(octet);
      return numeric >= 0 && numeric <= 255;
    })
  );
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Hetzner hard user-data size limit (32KB). */
export const HETZNER_USER_DATA_MAX_BYTES = 32 * 1024;

/**
 * Validate cloud-init config doesn't exceed Hetzner 32KB user-data limit.
 */
export function validateCloudInitSize(config: string): boolean {
  const sizeBytes = new TextEncoder().encode(config).length;
  return sizeBytes <= HETZNER_USER_DATA_MAX_BYTES;
}
