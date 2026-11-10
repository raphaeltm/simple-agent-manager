import { validateTunnelVariables } from './tunnel';
import type { CloudInitVariables, CloudProvider } from './variables';
import { VALID_CLOUD_PROVIDERS } from './variables';

// --- Validation patterns for shell-embedded variables ---

/** Alphanumeric, hyphens, underscores (IDs like nodeId, projectId, etc.) */
const SAFE_ID_RE = /^[a-zA-Z0-9_-]+$/;

/** Full lowercase Git commit SHA used for immutable VM-agent releases. */
const VM_AGENT_RELEASE_RE = /^[0-9a-f]{40}$/;

/** Valid hostname: alphanumeric, hyphens, dots */
const SAFE_HOSTNAME_RE = /^[a-zA-Z0-9.-]+$/;

/** Numeric positive integer */
const NUMERIC_RE = /^[0-9]+$/;

/** Highest workspace build queue depth accepted in cloud-init variables. */
const WORKSPACE_BUILD_QUEUE_DEPTH_MAX = 16;

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

/** Absolute Linux path without whitespace or shell metacharacters. */
const SAFE_ABSOLUTE_PATH_RE = /^\/[a-zA-Z0-9._/-]+$/;

function isSafeAbsolutePath(value: string): boolean {
  if (!SAFE_ABSOLUTE_PATH_RE.test(value) || value.includes('//')) {
    return false;
  }
  return value.split('/').every((segment) => segment !== '.' && segment !== '..');
}

/**
 * Validate all CloudInitVariables before they are embedded into shell/YAML.
 * Throws an error describing the first invalid field found.
 */
export function validateCloudInitVariables(variables: CloudInitVariables): void {
  const errors: string[] = [];

  for (const name of [
    'agentDownloadTimeoutSeconds',
    'certMaxAttempts',
    'certBaseDelaySeconds',
    'certMaxDelaySeconds',
    'certRequestTimeoutSeconds',
  ] as const) {
    const value = variables[name];
    if (
      value !== undefined &&
      (!NUMERIC_RE.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1)
    ) {
      errors.push(`${name}: must be a positive integer`);
    }
  }

  // Required fields
  if (!variables.nodeId || !SAFE_ID_RE.test(variables.nodeId)) {
    errors.push(`nodeId: must match ${SAFE_ID_RE} (got ${JSON.stringify(variables.nodeId)})`);
  }
  for (const name of ['nodeUserId', 'nodeRuntimeIncarnationId'] as const) {
    if (variables[name] !== undefined && !SAFE_ID_RE.test(variables[name])) {
      errors.push(`${name}: must contain only safe identifier characters`);
    }
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
  if (
    variables.vmAgentRequiredVersion !== undefined &&
    variables.vmAgentRequiredVersion !== '' &&
    !VM_AGENT_RELEASE_RE.test(variables.vmAgentRequiredVersion)
  ) {
    errors.push(
      `vmAgentRequiredVersion: must be a full lowercase Git commit SHA (got ${JSON.stringify(variables.vmAgentRequiredVersion)})`
    );
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
  if (
    variables.workspaceBuildQueueDepth !== undefined &&
    variables.workspaceBuildQueueDepth !== ''
  ) {
    const depth = Number(variables.workspaceBuildQueueDepth);
    if (
      !NUMERIC_RE.test(variables.workspaceBuildQueueDepth) ||
      depth < 1 ||
      depth > WORKSPACE_BUILD_QUEUE_DEPTH_MAX
    ) {
      errors.push(
        `workspaceBuildQueueDepth: must be numeric 1-${WORKSPACE_BUILD_QUEUE_DEPTH_MAX} (got ${JSON.stringify(variables.workspaceBuildQueueDepth)})`
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
  if (variables.vmAgentMemoryReserveMb !== undefined && variables.vmAgentMemoryReserveMb !== '') {
    const reserve = Number(variables.vmAgentMemoryReserveMb);
    if (!NUMERIC_RE.test(variables.vmAgentMemoryReserveMb) || reserve < 0 || reserve > 65536) {
      errors.push(
        `vmAgentMemoryReserveMb: must be numeric 0-65536 (got ${JSON.stringify(variables.vmAgentMemoryReserveMb)})`
      );
    }
  }
  if (
    variables.samInfraSliceMemoryMinMb !== undefined &&
    variables.samInfraSliceMemoryMinMb !== ''
  ) {
    const reserve = Number(variables.samInfraSliceMemoryMinMb);
    if (!NUMERIC_RE.test(variables.samInfraSliceMemoryMinMb) || reserve < 1 || reserve > 65536) {
      errors.push(
        `samInfraSliceMemoryMinMb: must be numeric 1-65536 (got ${JSON.stringify(variables.samInfraSliceMemoryMinMb)})`
      );
    }
  }
  for (const [field, raw] of [
    ['samInfraSliceCpuWeight', variables.samInfraSliceCpuWeight],
    ['samWorkloadSliceCpuWeight', variables.samWorkloadSliceCpuWeight],
  ] as const) {
    if (raw === undefined || raw === '') continue;
    const weight = Number(raw);
    // systemd/cgroup v2 accepts 1-10000 for CPUWeight; anything else makes the
    // unit fail to load, which would take the whole slice hierarchy down.
    if (!NUMERIC_RE.test(raw) || weight < 1 || weight > 10000) {
      errors.push(`${field}: must be numeric 1-10000 (got ${JSON.stringify(raw)})`);
    }
  }
  if (variables.dockerMemoryMinMb !== undefined && variables.dockerMemoryMinMb !== '') {
    const minimum = Number(variables.dockerMemoryMinMb);
    if (!NUMERIC_RE.test(variables.dockerMemoryMinMb) || minimum < 1 || minimum > 65536) {
      errors.push(
        `dockerMemoryMinMb: must be numeric 1-65536 (got ${JSON.stringify(variables.dockerMemoryMinMb)})`
      );
    }
  }
  if (
    variables.heartbeatDockerStatsTimeout !== undefined &&
    variables.heartbeatDockerStatsTimeout !== '' &&
    !GO_DURATION_RE.test(variables.heartbeatDockerStatsTimeout)
  ) {
    errors.push(
      `heartbeatDockerStatsTimeout: must be a Go duration (got ${JSON.stringify(variables.heartbeatDockerStatsTimeout)})`
    );
  }
  if (
    variables.heartbeatWorkspaceMetricsMaxContainers !== undefined &&
    variables.heartbeatWorkspaceMetricsMaxContainers !== ''
  ) {
    const maxContainers = Number(variables.heartbeatWorkspaceMetricsMaxContainers);
    if (
      !NUMERIC_RE.test(variables.heartbeatWorkspaceMetricsMaxContainers) ||
      maxContainers < 0 ||
      maxContainers > 128
    ) {
      errors.push(
        `heartbeatWorkspaceMetricsMaxContainers: must be numeric 0-128 (got ${JSON.stringify(variables.heartbeatWorkspaceMetricsMaxContainers)})`
      );
    }
  }
  if (
    variables.heartbeatWorkspaceMetricsMaxOutputBytes !== undefined &&
    variables.heartbeatWorkspaceMetricsMaxOutputBytes !== ''
  ) {
    const maxOutputBytes = Number(variables.heartbeatWorkspaceMetricsMaxOutputBytes);
    if (
      !NUMERIC_RE.test(variables.heartbeatWorkspaceMetricsMaxOutputBytes) ||
      maxOutputBytes < 1024 ||
      maxOutputBytes > 1048576
    ) {
      errors.push(
        `heartbeatWorkspaceMetricsMaxOutputBytes: must be numeric 1024-1048576 (got ${JSON.stringify(variables.heartbeatWorkspaceMetricsMaxOutputBytes)})`
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
  if (
    variables.sessionSnapshotOperationTimeout !== undefined &&
    variables.sessionSnapshotOperationTimeout !== '' &&
    !GO_DURATION_RE.test(variables.sessionSnapshotOperationTimeout)
  ) {
    errors.push(
      `sessionSnapshotOperationTimeout: must be a Go duration using ns/us/ms/s/m/h units (got ${JSON.stringify(variables.sessionSnapshotOperationTimeout)})`
    );
  }
  for (const [name, value] of [
    ['sessionSnapshotProgressReportInterval', variables.sessionSnapshotProgressReportInterval],
    ['sessionSnapshotProgressReportTimeout', variables.sessionSnapshotProgressReportTimeout],
  ] as const) {
    if (value !== undefined && value !== '' && !GO_DURATION_RE.test(value)) {
      errors.push(`${name}: must be a Go duration (got ${JSON.stringify(value)})`);
    }
  }
  for (const [name, value] of [
    ['errorReportFlushInterval', variables.errorReportFlushInterval],
    ['errorReportHttpTimeout', variables.errorReportHttpTimeout],
    ['errorReportRetryInitial', variables.errorReportRetryInitial],
    ['errorReportRetryMax', variables.errorReportRetryMax],
    ['errorReportDbBusyTimeout', variables.errorReportDbBusyTimeout],
    ['errorReportRetention', variables.errorReportRetention],
    ['errorReportCollectorTimeout', variables.errorReportCollectorTimeout],
  ] as const) {
    if (value !== undefined && value !== '' && !GO_DURATION_RE.test(value)) {
      errors.push(`${name}: must be a Go duration (got ${JSON.stringify(value)})`);
    }
  }
  for (const [name, value] of [
    ['errorReportMaxBatchSize', variables.errorReportMaxBatchSize],
    ['errorReportMaxBatchBytes', variables.errorReportMaxBatchBytes],
    ['errorReportMaxQueueSize', variables.errorReportMaxQueueSize],
    ['errorReportMaxAttempts', variables.errorReportMaxAttempts],
    ['errorReportArtifactMaxBytes', variables.errorReportArtifactMaxBytes],
    ['errorReportSpoolMaxBytes', variables.errorReportSpoolMaxBytes],
    ['errorReportMaxCollectorDocs', variables.errorReportMaxCollectorDocs],
    ['errorReportMaxDocumentBytes', variables.errorReportMaxDocumentBytes],
    ['errorReportMaxValueDepth', variables.errorReportMaxValueDepth],
    ['errorReportMaxValueItems', variables.errorReportMaxValueItems],
    ['errorReportMaxStringBytes', variables.errorReportMaxStringBytes],
    ['errorReportEventLimit', variables.errorReportEventLimit],
    ['errorReportResponseMaxBytes', variables.errorReportResponseMaxBytes],
    ['errorReportStoredErrorMaxBytes', variables.errorReportStoredErrorMaxBytes],
    ['errorReportCollectorConcurrency', variables.errorReportCollectorConcurrency],
  ] as const) {
    const numeric = Number(value);
    if (
      value !== undefined &&
      value !== '' &&
      (!NUMERIC_RE.test(value) || !Number.isSafeInteger(numeric) || numeric < 1)
    ) {
      errors.push(`${name}: must be a positive integer (got ${JSON.stringify(value)})`);
    }
  }
  for (const [name, value] of [
    ['errorReportDbPath', variables.errorReportDbPath],
    ['errorReportSpoolDir', variables.errorReportSpoolDir],
  ] as const) {
    if (value !== undefined && value !== '' && !isSafeAbsolutePath(value)) {
      errors.push(`${name}: must be a safe absolute path (got ${JSON.stringify(value)})`);
    }
  }

  validateTunnelVariables(variables, errors);

  if (errors.length > 0) {
    throw new Error(`Cloud-init variable validation failed:\n${errors.join('\n')}`);
  }
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
