import { CLOUD_INIT_TEMPLATE } from './template';
import { ingressFragments, tunnelReplacements } from './tunnel';
import { validateCloudInitVariables } from './validate';
import type { CloudInitVariables } from './variables';

export { validateCloudInitVariables } from './validate';
export type { CloudInitVariables, CloudProvider } from './variables';
export { VALID_CLOUD_PROVIDERS } from './variables';

/**
 * Options for cloud-init generation.
 */
export interface GenerateCloudInitOptions {
  /** Whether to validate the output size against the 32KB Hetzner limit (default: true) */
  validateSize?: boolean;
}

function defaultWhenBlank(value: string | undefined, fallback: string): string {
  return value === undefined || value === '' ? fallback : value;
}

/**
 * Generate cloud-init configuration from template with variables.
 */
export function generateCloudInit(
  variables: CloudInitVariables,
  options?: GenerateCloudInitOptions
): string {
  validateCloudInitVariables(variables);

  // Ingress fragments go in first: they contain placeholders of their own.
  let config = CLOUD_INIT_TEMPLATE;
  for (const [placeholder, fragment] of Object.entries(ingressFragments(variables))) {
    config = config.replace(placeholder, () => fragment);
  }

  const replacements: Record<string, string> = {
    '{{ node_id }}': variables.nodeId,
    '{{ node_user_id }}': variables.nodeUserId ?? '',
    '{{ node_runtime_incarnation_id }}': variables.nodeRuntimeIncarnationId ?? '',
    '{{ hostname }}': variables.hostname,
    '{{ control_plane_url }}': variables.controlPlaneUrl,
    '{{ vm_agent_release_query }}': variables.vmAgentRequiredVersion
      ? '&release=' + variables.vmAgentRequiredVersion
      : '',
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
    '{{ vm_agent_port }}':
      variables.vmAgentPort ?? (variables.originCaCertificateUrl ? '8443' : '8080'),
    '{{ tls_cert_path }}': variables.originCaCertificateUrl ? '/etc/sam/tls/origin-ca.pem' : '',
    '{{ tls_key_path }}': variables.originCaCertificateUrl ? '/etc/sam/tls/origin-ca-key.pem' : '',
    '{{ origin_ca_certificate_url }}': variables.originCaCertificateUrl ?? '',
    '{{ agent_download_timeout_seconds }}': variables.agentDownloadTimeoutSeconds ?? '60',
    '{{ cert_max_attempts }}': variables.certMaxAttempts ?? '3',
    '{{ cert_base_delay_seconds }}': variables.certBaseDelaySeconds ?? '2',
    '{{ cert_max_delay_seconds }}': variables.certMaxDelaySeconds ?? '8',
    '{{ cert_request_timeout_seconds }}': variables.certRequestTimeoutSeconds ?? '45',
    '{{ cf_ip_fetch_timeout }}': variables.cfIpFetchTimeout ?? '10',
    '{{ provider }}': variables.provider ?? '',
    '{{ devcontainer_cache_enabled }}': variables.devcontainerCacheEnabled ?? 'false',
    '{{ workspace_build_queue_depth }}': variables.workspaceBuildQueueDepth ?? '1',
    '{{ swap_size_mb }}': variables.swapSizeMb ?? '2048',
    '{{ swap_swappiness }}': variables.swapSwappiness ?? '60',
    '{{ vm_agent_memory_reserve_mb }}': variables.vmAgentMemoryReserveMb ?? '1024',
    '{{ sam_infra_slice_memory_min_mb }}': variables.samInfraSliceMemoryMinMb ?? '256',
    // The vm-agent shares the CPU with workload containers. Memory already has a
    // reservation (MemoryMin above) because starvation there KILLS the agent;
    // CPU had none, so a busy workspace could delay the heartbeat until the
    // control plane declared the node dead. CFS weights are proportional and
    // only apply under contention, so this costs nothing on an idle box: the
    // agent's demand is tiny, it simply stops queueing behind builds.
    '{{ sam_infra_slice_cpu_weight }}': defaultWhenBlank(variables.samInfraSliceCpuWeight, '1000'),
    '{{ sam_workload_slice_cpu_weight }}': defaultWhenBlank(
      variables.samWorkloadSliceCpuWeight,
      '100'
    ),
    '{{ docker_memory_min_mb }}': variables.dockerMemoryMinMb ?? '512',
    '{{ heartbeat_docker_stats_timeout }}': variables.heartbeatDockerStatsTimeout ?? '2s',
    '{{ heartbeat_workspace_metrics_max_containers }}':
      variables.heartbeatWorkspaceMetricsMaxContainers ?? '8',
    '{{ heartbeat_workspace_metrics_max_output_bytes }}':
      variables.heartbeatWorkspaceMetricsMaxOutputBytes ?? '65536',
    '{{ role }}': variables.role ?? '',
    '{{ environment_id }}': variables.environmentId ?? '',
    '{{ deploy_signing_pub_key }}': variables.deploySigningPubKey ?? '',
    '{{ deploy_acme_email }}': variables.deployAcmeEmail ?? '',
    '{{ deploy_acme_ca }}': variables.deployAcmeCa ?? '',
    '{{ deploy_compose_cmd }}': variables.deployComposeCmd ?? '',
    '{{ deploy_health_timeout }}': variables.deployHealthTimeout ?? '',
    '{{ session_snapshot_operation_timeout }}': variables.sessionSnapshotOperationTimeout ?? '15m',
    '{{ session_snapshot_progress_report_interval }}':
      variables.sessionSnapshotProgressReportInterval ?? '15s',
    '{{ session_snapshot_progress_report_timeout }}':
      variables.sessionSnapshotProgressReportTimeout ?? '5s',
    '{{ error_report_flush_interval }}': variables.errorReportFlushInterval ?? '30s',
    '{{ error_report_max_batch_size }}': variables.errorReportMaxBatchSize ?? '10',
    '{{ error_report_max_batch_bytes }}': variables.errorReportMaxBatchBytes ?? '32768',
    '{{ error_report_max_queue_size }}': variables.errorReportMaxQueueSize ?? '1000',
    '{{ error_report_http_timeout }}': variables.errorReportHttpTimeout ?? '10s',
    '{{ error_report_retry_initial }}': variables.errorReportRetryInitial ?? '1s',
    '{{ error_report_retry_max }}': variables.errorReportRetryMax ?? '5m',
    '{{ error_report_max_attempts }}': variables.errorReportMaxAttempts ?? '20',
    '{{ error_report_db_path }}':
      variables.errorReportDbPath ?? '/var/lib/vm-agent/error-reports.db',
    '{{ error_report_db_busy_timeout }}': variables.errorReportDbBusyTimeout ?? '5s',
    '{{ error_report_spool_dir }}':
      variables.errorReportSpoolDir ?? '/var/lib/vm-agent/diagnostic-incidents',
    '{{ error_report_artifact_max_bytes }}': variables.errorReportArtifactMaxBytes ?? '2097152',
    '{{ error_report_spool_max_bytes }}': variables.errorReportSpoolMaxBytes ?? '20971520',
    '{{ error_report_retention }}': variables.errorReportRetention ?? '24h',
    '{{ error_report_collector_timeout }}': variables.errorReportCollectorTimeout ?? '10s',
    '{{ error_report_max_collector_docs }}': variables.errorReportMaxCollectorDocs ?? '8',
    '{{ error_report_max_document_bytes }}': variables.errorReportMaxDocumentBytes ?? '131072',
    '{{ error_report_max_value_depth }}': variables.errorReportMaxValueDepth ?? '8',
    '{{ error_report_max_value_items }}': variables.errorReportMaxValueItems ?? '256',
    '{{ error_report_max_string_bytes }}': variables.errorReportMaxStringBytes ?? '4096',
    '{{ error_report_event_limit }}': variables.errorReportEventLimit ?? '100',
    '{{ error_report_response_max_bytes }}': variables.errorReportResponseMaxBytes ?? '4096',
    '{{ error_report_stored_error_max_bytes }}': variables.errorReportStoredErrorMaxBytes ?? '512',
    '{{ error_report_collector_concurrency }}': variables.errorReportCollectorConcurrency ?? '1',
  };

  Object.assign(replacements, tunnelReplacements(variables));

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
