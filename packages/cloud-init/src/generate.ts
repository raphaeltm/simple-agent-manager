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
  };

  for (const [placeholder, value] of Object.entries(replacements)) {
    config = config.replace(new RegExp(escapeRegExp(placeholder), 'g'), value);
  }

  return config;
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
