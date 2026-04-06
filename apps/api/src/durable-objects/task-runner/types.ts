/**
 * Types for the TaskRunner Durable Object.
 *
 * Extracted from task-runner.ts for modularity.
 */
import type {
  CredentialProvider,
  TaskAttachment,
  TaskExecutionStep,
  TaskMode,
  VMLocation,
  VMSize,
  WorkspaceProfile,
} from '@simple-agent-manager/shared';

import type { Env } from '../../index';

// TaskRunner uses the full Env type because it delegates to service functions
// (createNodeRecord, provisionNode, createWorkspaceOnNode, etc.) that expect
// the complete Worker Env interface. DOs receive the full env at runtime.

export interface StepResults {
  nodeId: string | null;
  autoProvisioned: boolean;
  workspaceId: string | null;
  chatSessionId: string | null;
  agentSessionId: string | null;
  agentStarted: boolean;
  /** Opaque MCP token for agent platform awareness (stored in KV) */
  mcpToken: string | null;
}

export interface TaskRunConfig {
  vmSize: VMSize;
  vmLocation: VMLocation;
  branch: string;
  preferredNodeId: string | null;
  userName: string | null;
  userEmail: string | null;
  githubId: string | null;
  taskTitle: string;
  taskDescription: string | null;
  repository: string;
  installationId: string;
  outputBranch: string | null;
  projectDefaultVmSize: VMSize | null;
  /** Chat session ID created at task submit time (TDF-6: single session per task) */
  chatSessionId: string | null;
  /** Agent type to use (e.g., 'claude-code', 'openai-codex'). Falls back to DEFAULT_TASK_AGENT_TYPE env var. */
  agentType: string | null;
  /** Workspace provisioning profile. 'lightweight' skips devcontainer build for faster startup. */
  workspaceProfile: WorkspaceProfile | null;
  /** Cloud provider for auto-provisioned nodes. Null means system picks any available credential. */
  cloudProvider: CredentialProvider | null;
  /** Task execution mode. 'task' = push/PR/complete lifecycle. 'conversation' = human-controlled. */
  taskMode: TaskMode;
  /** Model override from agent profile (forwarded to VM agent). Null = use agent default. */
  model: string | null;
  /** Permission mode override from agent profile (forwarded to VM agent). Null = use agent default. */
  permissionMode: string | null;
  /** System prompt text to append to the initial prompt (from agent profile). Null = no append. */
  systemPromptAppend: string | null;
  /** ID of an agent profile to use for this task. Null = use project defaults. */
  agentProfileId: string | null;
  /** File attachments uploaded to R2 before task submission. Null = no attachments. */
  attachments: TaskAttachment[] | null;
  /** Per-project scaling overrides. Null values mean "use platform default". */
  projectScaling?: {
    taskExecutionTimeoutMs?: number | null;
    maxWorkspacesPerNode?: number | null;
    nodeCpuThresholdPercent?: number | null;
    nodeMemoryThresholdPercent?: number | null;
    warmNodeTimeoutMs?: number | null;
  } | null;
}

export interface TaskRunnerState {
  version: 1;
  taskId: string;
  projectId: string;
  userId: string;
  currentStep: TaskExecutionStep;
  stepResults: StepResults;
  config: TaskRunConfig;
  retryCount: number;
  workspaceReadyReceived: boolean;
  workspaceReadyStatus: 'running' | 'recovery' | 'error' | null;
  workspaceErrorMessage: string | null;
  createdAt: number;
  lastStepAt: number;
  /** Set when we started waiting for agent ready — used for timeout detection */
  agentReadyStartedAt: number | null;
  /** Set when we started waiting for workspace ready — used for timeout detection */
  workspaceReadyStartedAt: number | null;
  /** Terminal — DO has completed or failed, no more alarms */
  completed: boolean;
}

export interface StartTaskInput {
  taskId: string;
  projectId: string;
  userId: string;
  config: TaskRunConfig;
}

/**
 * Context object passed to extracted step handler functions.
 * Provides access to the DO's environment and storage without
 * requiring the functions to be class methods.
 */
export interface TaskRunnerContext {
  env: Env;
  ctx: DurableObjectState;
  /** Advance to next step: persist state, reset retries, schedule alarm */
  advanceToStep: (state: TaskRunnerState, nextStep: TaskExecutionStep) => Promise<void>;
  /** Get configurable timeout/interval values */
  getAgentPollIntervalMs: () => number;
  getAgentReadyTimeoutMs: () => number;
  getWorkspaceReadyTimeoutMs: () => number;
  getWorkspaceReadyPollIntervalMs: () => number;
  getProvisionPollIntervalMs: () => number;
  /** Update D1 execution step */
  updateD1ExecutionStep: (taskId: string, step: TaskExecutionStep) => Promise<void>;
}
