/** Inputs to cloud-init generation. Validated by `validateCloudInitVariables`. */

/** Valid cloud provider values for cloud-init. */
export const VALID_CLOUD_PROVIDERS = [
  'hetzner',
  'scaleway',
  'gcp',
  'vultr',
  'infomaniak',
  'digitalocean',
  'upcloud',
] as const;
export type CloudProvider = (typeof VALID_CLOUD_PROVIDERS)[number];

/**
 * Variables for cloud-init generation.
 */
export interface CloudInitVariables {
  nodeId: string;
  /** Stable owner and boot incarnation fence for physical workspace cleanup. */
  nodeUserId?: string;
  nodeRuntimeIncarnationId?: string;
  hostname: string;
  controlPlaneUrl: string;
  jwksUrl: string;
  callbackToken: string;
  /** Cloud provider (hetzner, scaleway, gcp, vultr, infomaniak). Used for provider-specific apt mirrors. */
  /** Cloud provider (hetzner, scaleway, gcp, vultr, digitalocean). Used for provider-specific apt mirrors. */
  /** Cloud provider (hetzner, scaleway, gcp, vultr, upcloud). Used for provider-specific apt mirrors. */
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
  /**
   * Cloudflare Tunnel connector run token for this node's tunnel. Non-empty
   * selects tunnel mode: no Origin CA certificate, no public agent ingress, a
   * pinned cloudflared connector forwarding to the agent's loopback tunnel
   * listener. Never the account API token.
   */
  cloudflareTunnelToken?: string;
  /** Loopback port of the agent's tunnel listener (default: 8444). Tunnel mode only. */
  cloudflareTunnelPort?: string;
  /** cloudflared release with pinned checksums (default: 2026.10.7). Tunnel mode only. */
  cloudflaredVersion?: string;
  /** Seconds the connector waits for the tunnel listener per start attempt (default: 120). */
  tunnelListenerWaitSeconds?: string;
  /** Node-scoped endpoint used at boot to sign a locally generated Origin CA CSR. */
  originCaCertificateUrl?: string;
  /** Deadline for the agent binary transfer, including DNS/connect time. */
  agentDownloadTimeoutSeconds?: string;
  certMaxAttempts?: string;
  certBaseDelaySeconds?: string;
  certMaxDelaySeconds?: string;
  certRequestTimeoutSeconds?: string;
  /** VM agent port override (default: 8443 with TLS, 8080 without) */
  vmAgentPort?: string;
  /** Immutable VM-agent release selected by the control-plane deployment. */
  vmAgentRequiredVersion?: string;
  /** Timeout in seconds for fetching Cloudflare IP ranges at boot (default: 10) */
  cfIpFetchTimeout?: string;
  /** Enable opportunistic devcontainer image caching via GHCR (default: false) */
  devcontainerCacheEnabled?: string;
  /** Concurrent devcontainer build slots on a workspace VM (default: 1). */
  workspaceBuildQueueDepth?: string;
  /** Swap file size in MB (default: 2048). Set to "0" to disable swap. */
  swapSizeMb?: string;
  /** Swap swappiness value 0-100 (default: 60). Only relevant when swap is enabled. */
  swapSwappiness?: string;
  /** Host memory reserve in MB subtracted from the Docker workload slice (default: 1024, matching the API's admission reserve). */
  vmAgentMemoryReserveMb?: string;
  /** Minimum memory protection for VM agent/system services in MB (default: 256). */
  samInfraSliceMemoryMinMb?: string;
  /** systemd CPUWeight for the vm-agent slice (cgroup v2 range 1-10000). */
  samInfraSliceCpuWeight?: string;
  /** systemd CPUWeight for the Docker workload slice (cgroup v2 range 1-10000). */
  samWorkloadSliceCpuWeight?: string;
  /** Minimum Docker MemoryMax value retained when reserve is enabled (default: 512). */
  dockerMemoryMinMb?: string;
  /** Bounded Docker stats timeout for heartbeat workspace metrics (default: 2s). */
  heartbeatDockerStatsTimeout?: string;
  /** Max workspace containers measured by each heartbeat (default: 8). */
  heartbeatWorkspaceMetricsMaxContainers?: string;
  /** Max bytes read from each heartbeat Docker CLI command (default: 65536). */
  heartbeatWorkspaceMetricsMaxOutputBytes?: string;
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
  /** Overall VM-agent checkpoint deadline, as a Go duration string (default: 15m). */
  sessionSnapshotOperationTimeout?: string;
  /** Min interval between VM-agent snapshot progress callbacks (default: 15s). */
  sessionSnapshotProgressReportInterval?: string;
  /** Timeout for each VM-agent snapshot progress callback (default: 5s). */
  sessionSnapshotProgressReportTimeout?: string;
  /** VM Agent durable error reporter tunables. */
  errorReportFlushInterval?: string;
  errorReportMaxBatchSize?: string;
  errorReportMaxBatchBytes?: string;
  errorReportMaxQueueSize?: string;
  errorReportHttpTimeout?: string;
  errorReportRetryInitial?: string;
  errorReportRetryMax?: string;
  errorReportMaxAttempts?: string;
  errorReportDbPath?: string;
  errorReportDbBusyTimeout?: string;
  errorReportSpoolDir?: string;
  errorReportArtifactMaxBytes?: string;
  errorReportSpoolMaxBytes?: string;
  errorReportRetention?: string;
  errorReportCollectorTimeout?: string;
  errorReportMaxCollectorDocs?: string;
  errorReportMaxDocumentBytes?: string;
  errorReportMaxValueDepth?: string;
  errorReportMaxValueItems?: string;
  errorReportMaxStringBytes?: string;
  errorReportEventLimit?: string;
  errorReportResponseMaxBytes?: string;
  errorReportStoredErrorMaxBytes?: string;
  errorReportCollectorConcurrency?: string;
}
