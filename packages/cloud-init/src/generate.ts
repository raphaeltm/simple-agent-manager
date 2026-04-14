import { CLOUD_INIT_TEMPLATE } from './template';

// --- Validation patterns for shell-embedded variables ---

/** Alphanumeric, hyphens, underscores (IDs like nodeId, projectId, etc.) */
const SAFE_ID_RE = /^[a-zA-Z0-9_-]+$/;

/** Valid hostname: alphanumeric, hyphens, dots */
const SAFE_HOSTNAME_RE = /^[a-zA-Z0-9.-]+$/;

/** Valid Docker image reference: registry/repo:tag@sha256:digest */
const SAFE_DOCKER_IMAGE_RE = /^[a-zA-Z0-9][a-zA-Z0-9./:@_-]*$/;

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

/** Docker DNS servers: one or more quoted dotted-decimal IPv4 addresses, comma-separated.
 * e.g. "1.1.1.1", "8.8.8.8" */
const SAFE_DNS_SERVERS_RE = /^"\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}"(, "\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}")*$/;

/**
 * PEM envelope: must start with -----BEGIN <label>----- and end with -----END <label>-----.
 * Content between markers must be base64 + whitespace only. Rejects YAML special characters
 * (`:`, `#`, `{`, `}`, `[`, `]`) outside the PEM structure.
 */
const PEM_ENVELOPE_RE = /^-----BEGIN [A-Z0-9 ]+(-----)\n[A-Za-z0-9+/=\s]+\n-----END [A-Z0-9 ]+(-----)$/;

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
    errors.push(`hostname: must match ${SAFE_HOSTNAME_RE} (got ${JSON.stringify(variables.hostname)})`);
  }
  if (!variables.controlPlaneUrl || !SAFE_URL_RE.test(variables.controlPlaneUrl)) {
    errors.push(`controlPlaneUrl: must be a valid HTTPS URL (got ${JSON.stringify(variables.controlPlaneUrl)})`);
  }
  if (!variables.jwksUrl || !SAFE_URL_RE.test(variables.jwksUrl)) {
    errors.push(`jwksUrl: must be a valid HTTPS URL (got ${JSON.stringify(variables.jwksUrl)})`);
  }
  if (!variables.callbackToken || !SAFE_TOKEN_RE.test(variables.callbackToken)) {
    errors.push(`callbackToken: must contain only safe token characters (got ${JSON.stringify(variables.callbackToken)})`);
  }

  // Optional fields — only validated when present and non-empty
  if (variables.vmAgentPort !== undefined && variables.vmAgentPort !== '') {
    const port = Number(variables.vmAgentPort);
    if (!NUMERIC_RE.test(variables.vmAgentPort) || port < 1 || port > 65535) {
      errors.push(`vmAgentPort: must be numeric 1-65535 (got ${JSON.stringify(variables.vmAgentPort)})`);
    }
  }
  if (variables.nekoImage !== undefined && variables.nekoImage !== '') {
    if (!SAFE_DOCKER_IMAGE_RE.test(variables.nekoImage)) {
      errors.push(`nekoImage: must match ${SAFE_DOCKER_IMAGE_RE} (got ${JSON.stringify(variables.nekoImage)})`);
    }
  }
  if (variables.cfIpFetchTimeout !== undefined && variables.cfIpFetchTimeout !== '') {
    if (!NUMERIC_RE.test(variables.cfIpFetchTimeout)) {
      errors.push(`cfIpFetchTimeout: must be a positive integer (got ${JSON.stringify(variables.cfIpFetchTimeout)})`);
    }
  }
  if (variables.projectId !== undefined && variables.projectId !== '') {
    if (!SAFE_ID_RE.test(variables.projectId)) {
      errors.push(`projectId: must match ${SAFE_ID_RE} (got ${JSON.stringify(variables.projectId)})`);
    }
  }
  if (variables.chatSessionId !== undefined && variables.chatSessionId !== '') {
    if (!SAFE_ID_RE.test(variables.chatSessionId)) {
      errors.push(`chatSessionId: must match ${SAFE_ID_RE} (got ${JSON.stringify(variables.chatSessionId)})`);
    }
  }
  if (variables.taskId !== undefined && variables.taskId !== '') {
    if (!SAFE_ID_RE.test(variables.taskId)) {
      errors.push(`taskId: must match ${SAFE_ID_RE} (got ${JSON.stringify(variables.taskId)})`);
    }
  }
  if (variables.taskMode !== undefined && variables.taskMode !== '') {
    if (variables.taskMode !== 'task' && variables.taskMode !== 'conversation') {
      errors.push(`taskMode: must be 'task' or 'conversation' (got ${JSON.stringify(variables.taskMode)})`);
    }
  }
  if (variables.logJournalMaxUse !== undefined && variables.logJournalMaxUse !== '') {
    if (!JOURNALD_SIZE_RE.test(variables.logJournalMaxUse)) {
      errors.push(`logJournalMaxUse: must match ${JOURNALD_SIZE_RE} (got ${JSON.stringify(variables.logJournalMaxUse)})`);
    }
  }
  if (variables.logJournalKeepFree !== undefined && variables.logJournalKeepFree !== '') {
    if (!JOURNALD_SIZE_RE.test(variables.logJournalKeepFree)) {
      errors.push(`logJournalKeepFree: must match ${JOURNALD_SIZE_RE} (got ${JSON.stringify(variables.logJournalKeepFree)})`);
    }
  }
  if (variables.logJournalMaxRetention !== undefined && variables.logJournalMaxRetention !== '') {
    if (!JOURNALD_TIME_RE.test(variables.logJournalMaxRetention)) {
      errors.push(`logJournalMaxRetention: must match ${JOURNALD_TIME_RE} (got ${JSON.stringify(variables.logJournalMaxRetention)})`);
    }
  }
  if (variables.dockerDnsServers !== undefined && variables.dockerDnsServers !== '') {
    if (!SAFE_DNS_SERVERS_RE.test(variables.dockerDnsServers)) {
      errors.push(`dockerDnsServers: must contain only quoted IPs (got ${JSON.stringify(variables.dockerDnsServers)})`);
    }
  }
  if (variables.originCaCert !== undefined && variables.originCaCert !== '') {
    if (!PEM_ENVELOPE_RE.test(variables.originCaCert)) {
      errors.push('originCaCert: must be a valid PEM-encoded certificate (-----BEGIN ... ----- / -----END ... -----)');
    }
  }
  if (variables.originCaKey !== undefined && variables.originCaKey !== '') {
    if (!PEM_ENVELOPE_RE.test(variables.originCaKey)) {
      errors.push('originCaKey: must be a valid PEM-encoded key (-----BEGIN ... ----- / -----END ... -----)');
    }
  }

  if (errors.length > 0) {
    throw new Error(`Cloud-init variable validation failed:\n${errors.join('\n')}`);
  }
}

/**
 * Variables for cloud-init generation.
 */
export interface CloudInitVariables {
  nodeId: string;
  hostname: string;
  controlPlaneUrl: string;
  jwksUrl: string;
  callbackToken: string;
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
  /** Origin CA certificate PEM for TLS between CF edge and VM agent (nullable) */
  originCaCert?: string;
  /** Origin CA private key PEM for TLS (nullable) */
  originCaKey?: string;
  /** VM agent port override (default: 8443 with TLS, 8080 without) */
  vmAgentPort?: string;
  /** Timeout in seconds for fetching Cloudflare IP ranges at boot (default: 10) */
  cfIpFetchTimeout?: string;
  /** Docker image for Neko browser sidecar (default: ghcr.io/m1k1o/neko/google-chrome:latest) */
  nekoImage?: string;
  /** Whether to pre-pull the Neko browser image during cloud-init (default: true) */
  nekoPrePull?: boolean;
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
  options?: GenerateCloudInitOptions,
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
    '{{ origin_ca_cert }}': indentForYamlBlock(variables.originCaCert ?? '', 6),
    '{{ origin_ca_key }}': indentForYamlBlock(variables.originCaKey ?? '', 6),
    '{{ vm_agent_port }}': variables.vmAgentPort ?? (variables.originCaCert ? '8443' : '8080'),
    '{{ tls_cert_path }}': variables.originCaCert ? '/etc/sam/tls/origin-ca.pem' : '',
    '{{ tls_key_path }}': variables.originCaCert ? '/etc/sam/tls/origin-ca-key.pem' : '',
    '{{ cf_ip_fetch_timeout }}': variables.cfIpFetchTimeout ?? '10',
    '{{ neko_pre_pull_cmd }}': buildNekoPrePullCmd(variables),
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
        `Cloud-init config exceeds 32KB Hetzner user-data limit (${sizeBytes} bytes)`,
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

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build the cloud-init runcmd entry for Neko image pre-pull.
 * Returns an empty comment line if pre-pull is disabled.
 */
function buildNekoPrePullCmd(variables: CloudInitVariables): string {
  const prePull = variables.nekoPrePull ?? true;
  if (!prePull) {
    return '# Neko pre-pull disabled';
  }
  const image = variables.nekoImage ?? 'ghcr.io/m1k1o/neko/google-chrome:latest';
  // Defense-in-depth: validate image name independently of top-level validation
  if (!SAFE_DOCKER_IMAGE_RE.test(image)) {
    throw new Error(`buildNekoPrePullCmd: unsafe Docker image reference: ${JSON.stringify(image)}`);
  }
  return `- docker pull '${image}' || true`;
}

/**
 * Validate cloud-init config doesn't exceed Hetzner 32KB user-data limit.
 */
export function validateCloudInitSize(config: string): boolean {
  const sizeBytes = new TextEncoder().encode(config).length;
  const maxBytes = 32 * 1024;
  return sizeBytes <= maxBytes;
}
