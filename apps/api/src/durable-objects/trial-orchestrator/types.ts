/**
 * Types for the TrialOrchestrator Durable Object.
 *
 * One DO instance per trialId, alarm-driven, mirrors TaskRunner's pattern.
 * See `apps/api/src/durable-objects/trial-orchestrator/index.ts` for lifecycle.
 */
import type { Env } from '../../env';

/**
 * State-machine steps for the trial provisioning flow.
 *
 *   project_creation → node_selection → [node_provisioning → node_agent_ready]
 *     → workspace_creation → workspace_ready → discovery_agent_start
 *     → running  (terminal — waits for ACP bridge to emit trial.ready)
 *
 * Terminal error steps: `failed`.
 */
export type TrialOrchestratorStep =
  | 'project_creation'
  | 'node_selection'
  | 'node_provisioning'
  | 'node_agent_ready'
  | 'workspace_creation'
  | 'workspace_ready'
  | 'discovery_agent_start'
  | 'running'
  | 'succeeded'
  | 'failed';

export interface TrialOrchestratorState {
  version: 1;
  trialId: string;
  /** Public GitHub repo URL (canonical form — see parseGithubRepoUrl). */
  repoUrl: string;
  repoOwner: string;
  repoName: string;
  currentStep: TrialOrchestratorStep;
  // Resolved step outputs — persisted so retries are idempotent.
  projectId: string | null;
  nodeId: string | null;
  autoProvisionedNode: boolean;
  workspaceId: string | null;
  chatSessionId: string | null;
  acpSessionId: string | null;
  // Timing / retry bookkeeping.
  retryCount: number;
  createdAt: number;
  lastStepAt: number;
  /** Filled when we start waiting for the VM-agent heartbeat. */
  nodeAgentReadyStartedAt: number | null;
  /** Filled when we start waiting for workspace status=running in D1. */
  workspaceReadyStartedAt: number | null;
  /** Terminal — no more alarms will fire. */
  completed: boolean;
  /** Failure reason (if currentStep = 'failed'). Emitted in trial.error. */
  failureReason: string | null;
}

export interface StartTrialInput {
  trialId: string;
  repoUrl: string;
  repoOwner: string;
  repoName: string;
}

/**
 * Context object passed to extracted step handler functions — same pattern as
 * TaskRunner. Lets step handlers stay as plain functions without importing the
 * DO class (which depends on `cloudflare:workers`).
 */
export interface TrialOrchestratorContext {
  env: Env;
  ctx: DurableObjectState;
  /** Advance to a new step: reset retries, persist, schedule alarm for immediate dispatch. */
  advanceToStep: (state: TrialOrchestratorState, nextStep: TrialOrchestratorStep) => Promise<void>;
  // Tunable knobs (all backed by env vars with DEFAULT_* fallbacks).
  getOverallTimeoutMs: () => number;
  getRetryBaseDelayMs: () => number;
  getRetryMaxDelayMs: () => number;
  getMaxRetries: () => number;
  getWorkspaceReadyTimeoutMs: () => number;
  getWorkspaceReadyPollIntervalMs: () => number;
  getNodeReadyTimeoutMs: () => number;
  getAgentReadyTimeoutMs: () => number;
  getHeartbeatSkewMs: () => number;
}
