import { CLOUD_INIT_TEMPLATE } from './template';

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
  /** Docker daemon DNS servers as JSON array content (default: "1.1.1.1", "8.8.8.8") */
  dockerDnsServers?: string;
  /** Origin CA certificate PEM for TLS between CF edge and VM agent (nullable) */
  originCaCert?: string;
  /** Origin CA private key PEM for TLS (nullable) */
  originCaKey?: string;
  /** VM agent port override (default: 8443 with TLS, 8080 without) */
  vmAgentPort?: string;
}

/**
 * Generate cloud-init configuration from template with variables.
 */
export function generateCloudInit(variables: CloudInitVariables): string {
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
    '{{ docker_name_tag }}': '{{.Name}}',
    '{{ docker_dns_servers }}': variables.dockerDnsServers ?? '"1.1.1.1", "8.8.8.8"',
    '{{ origin_ca_cert }}': indentForYamlBlock(variables.originCaCert ?? '', 6),
    '{{ origin_ca_key }}': indentForYamlBlock(variables.originCaKey ?? '', 6),
    '{{ vm_agent_port }}': variables.vmAgentPort ?? (variables.originCaCert ? '8443' : '8080'),
    '{{ tls_cert_path }}': variables.originCaCert ? '/etc/sam/tls/origin-ca.pem' : '',
    '{{ tls_key_path }}': variables.originCaCert ? '/etc/sam/tls/origin-ca-key.pem' : '',
  };

  for (const [placeholder, value] of Object.entries(replacements)) {
    config = config.replace(new RegExp(escapeRegExp(placeholder), 'g'), value);
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
 * Validate cloud-init config doesn't exceed Hetzner 32KB user-data limit.
 */
export function validateCloudInitSize(config: string): boolean {
  const sizeBytes = new TextEncoder().encode(config).length;
  const maxBytes = 32 * 1024;
  return sizeBytes <= maxBytes;
}
