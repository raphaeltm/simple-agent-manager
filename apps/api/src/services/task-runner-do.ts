/**
 * TaskRunner DO Service — helper functions for Worker routes to interact
 * with the TaskRunner Durable Object.
 *
 * This is the bridge between HTTP routes and the DO. Routes should call
 * these functions instead of accessing the DO binding directly.
 */
import type {
  AgentEffort,
  CredentialProvider,
  CredentialSource,
  ResolvedResourceReservation,
  ResourceRequirements,
  ResourceRequirementsSource,
  TaskAttachment,
  TaskMode,
  VMLocation,
  VMSize,
  WorkspaceProfile,
} from '@simple-agent-manager/shared';

import type { StartTaskInput, TaskRunner } from '../durable-objects/task-runner';
import type { Env } from '../env';
import { log } from '../lib/logger';
import type {
  TaskStartCapacityCandidate,
  TaskStartCapacityPoolSelection,
} from './placement-resolver';
import { assertReplacementDeletionConfirmed } from './replacement-deletion-fence';
import type { ProjectEventWakeRecoveryGuard } from './session-recovery-authority';
import type { TaskRunnerStartGuard } from './task-runner-start-guard';

const TASK_RUNNER_COMPACT_SELECTION_MAX_BYTES = 96 * 1024;

/**
 * Get a typed DO stub for the given task.
 * Uses `idFromName(taskId)` for deterministic mapping — one DO per task.
 */
function getStub(env: Env, taskId: string): DurableObjectStub<TaskRunner> {
  const id = env.TASK_RUNNER.idFromName(taskId);
  return env.TASK_RUNNER.get(id) as DurableObjectStub<TaskRunner>;
}

function capacityCandidateMatchesStartInput(
  candidate: TaskStartCapacityCandidate,
  input: {
    cloudProvider?: CredentialProvider | null;
    explicitVmLocation?: boolean | null;
    vmLocation: VMLocation;
  }
): boolean {
  if (input.cloudProvider && candidate.provider !== input.cloudProvider) return false;
  if (input.explicitVmLocation === true && candidate.location !== input.vmLocation) return false;
  return true;
}

function capacityPoolSelectionForStart(input: {
  capacityPoolSelection?: TaskStartCapacityPoolSelection | null;
  cloudProvider?: CredentialProvider | null;
  explicitVmLocation?: boolean | null;
  vmLocation: VMLocation;
}): TaskStartCapacityPoolSelection | null {
  const selection = input.capacityPoolSelection ?? null;
  const candidate = selection?.candidates[0] ?? null;
  if (!selection || !candidate) return selection;
  if (!capacityCandidateMatchesStartInput(candidate, input)) return null;
  return compactCapacityPoolSelectionForTaskRunner(selection);
}

function compactCapacityPoolSelectionForTaskRunner(
  selection: TaskStartCapacityPoolSelection
): TaskStartCapacityPoolSelection {
  const compactSelection: TaskStartCapacityPoolSelection = {
    ...selection,
    poolSnapshot: {
      ...selection.poolSnapshot,
      placementExplanationJson: null,
    },
    candidates: selection.candidates.map((candidate, index) =>
      compactCapacityCandidateForTaskRunner(candidate, { primary: index === 0 })
    ),
  };

  const fitsCandidates = (candidates: TaskStartCapacityCandidate[]) =>
    selectionBytes({ ...compactSelection, candidates }) <= TASK_RUNNER_COMPACT_SELECTION_MAX_BYTES;
  const all = compactSelection.candidates;
  if (fitsCandidates(all)) return compactSelection;
  if (!fitsCandidates(all.slice(0, 1))) {
    // Even the primary alone would push TaskRunner state toward the Durable Object value
    // limit, where `start()` fails with a storage error that names nothing. Fail here instead.
    const bytes = selectionBytes({ ...compactSelection, candidates: all.slice(0, 1) });
    log.error('task_runner_do.capacity_selection_too_large', {
      poolId: selection.poolId,
      bytes,
      maxBytes: TASK_RUNNER_COMPACT_SELECTION_MAX_BYTES,
    });
    throw new Error(
      `Capacity pool ${selection.poolId} selection is ${bytes} bytes with one candidate, over the ${TASK_RUNNER_COMPACT_SELECTION_MAX_BYTES}-byte TaskRunner budget`
    );
  }

  // Candidates are ranked best first and every one after the first is a fallback the
  // exhaustion chain may try (another zone or machine type when one is sold out). Keep the
  // longest ranked prefix that fits, not just the first: a live catalog spanning many zones
  // otherwise reaches the TaskRunner with no fallback at all. Always keep at least one.
  //
  // With a provider order, rank sorts the first source's candidates ahead of every other, and
  // a live GCP catalog alone exceeds the budget, so that prefix would drop every later provider
  // tier. Keep each source's best `k` candidates instead, for the largest `k` that fits.
  const perSource = hasProviderOrder(all) ? bestPerSource(all) : null;
  const usePerSource = perSource !== null && fitsCandidates(perSource.take(1));
  const take = usePerSource ? perSource.take : (k: number) => all.slice(0, k);
  let low = 1;
  let high = usePerSource ? perSource.largestSource : all.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (fitsCandidates(take(mid))) low = mid;
    else high = mid - 1;
  }
  const kept = take(low);
  log.info('task_runner_do.capacity_candidates_truncated', {
    poolId: selection.poolId,
    kept: kept.length,
    dropped: all.length - kept.length,
    perSource: usePerSource,
    maxBytes: TASK_RUNNER_COMPACT_SELECTION_MAX_BYTES,
  });
  return { ...compactSelection, candidates: kept };
}

function hasProviderOrder(candidates: readonly TaskStartCapacityCandidate[]): boolean {
  return candidates.some(
    (candidate) => candidate.sourceRank !== null && candidate.sourceRank !== undefined
  );
}

/** `take(k)`: every source's first `k` candidates, in their original (ranked) order. */
function bestPerSource(candidates: readonly TaskStartCapacityCandidate[]) {
  const seen = new Map<string, number>();
  const indexInSource = candidates.map((candidate) => {
    const index = seen.get(candidate.capacitySourceId) ?? 0;
    seen.set(candidate.capacitySourceId, index + 1);
    return index;
  });
  return {
    largestSource: Math.max(...seen.values()),
    take: (k: number) => candidates.filter((_, index) => (indexInSource[index] ?? 0) < k),
  };
}

function selectionBytes(selection: TaskStartCapacityPoolSelection): number {
  return new TextEncoder().encode(JSON.stringify(selection)).length;
}

function compactCapacityCandidateForTaskRunner(
  candidate: TaskStartCapacityCandidate,
  options: { primary: boolean }
): TaskStartCapacityCandidate {
  const rest = { ...candidate };
  delete rest.snapshot;
  // Any candidate may become the selected reuse/provisioning target. Its prices
  // remain part of placement diagnostics and ranking after snapshot compaction.
  return {
    ...rest,
    machineClass: options.primary ? candidate.machineClass : null,
  };
}

/**
 * Start a TaskRunner DO for the given task.
 * Called from task-submit and task-runs routes after creating the task in D1.
 */
export async function startTaskRunnerDO(
  env: Env,
  input: {
    taskId: string;
    projectId: string;
    userId: string;
    vmSize: VMSize;
    vmLocation: VMLocation;
    branch: string;
    defaultBranch?: string;
    preferredNodeId?: string | null;
    excludedNodeId?: string | null;
    userName?: string | null;
    userEmail?: string | null;
    githubId?: string | null;
    taskTitle: string;
    taskDescription?: string | null;
    historicalContext?: string | null;
    repository: string;
    installationId: string;
    outputBranch?: string | null;
    projectDefaultVmSize?: VMSize | null;
    /** Chat session ID created at task submit time (TDF-6) */
    chatSessionId?: string | null;
    /** Agent type to use (e.g., 'claude-code', 'openai-codex') */
    agentType?: string | null;
    /** Workspace provisioning profile. 'lightweight' skips devcontainer build. */
    workspaceProfile?: WorkspaceProfile | null;
    /** Devcontainer config name (subdirectory under .devcontainer/). Null = auto-discover. */
    devcontainerConfigName?: string | null;
    /** Cloud provider for auto-provisioned nodes. Falls back to any available credential. */
    cloudProvider?: CredentialProvider | null;
    /** Whether vmLocation came from a caller-supplied explicit placement override. */
    explicitVmLocation?: boolean | null;
    /** Root-pinned credential attribution user for this task tree. */
    credentialAttributionUserId?: string | null;
    /** Project scope when credentialAttributionSource is 'project'. */
    credentialAttributionProjectId?: string | null;
    /** Root-pinned credential attribution source. */
    credentialAttributionSource?: CredentialSource | null;
    /** Task execution mode. 'task' = push/PR/complete. 'conversation' = human-controlled. */
    taskMode?: TaskMode;
    /** Model override from agent profile. Null = use agent default. */
    model?: string | null;
    /** Reasoning effort override from agent profile. Null = use agent default. */
    effort?: AgentEffort | null;
    /** Permission mode override from agent profile. Null = use agent default. */
    permissionMode?: string | null;
    /** OpenCode inference provider override. Null = use agent default. */
    opencodeProvider?: string | null;
    /** OpenCode base URL override for custom/openai-compatible providers. */
    opencodeBaseUrl?: string | null;
    /** System prompt text to append to the initial prompt (from agent profile). */
    systemPromptAppend?: string | null;
    /** Agent profile ID — stored on workspace for GitHub CLI policy enforcement. */
    agentProfileHint?: string | null;
    /** File attachments uploaded to R2 before task submission. */
    attachments?: TaskAttachment[] | null;
    /** Per-project scaling overrides. */
    projectScaling?: {
      taskExecutionTimeoutMs?: number | null;
      nodeCpuThresholdPercent?: number | null;
      nodeMemoryThresholdPercent?: number | null;
      nodeCpuShareBudgetPercent?: number | null;
      nodeHostMemoryReserveMb?: number | null;
      nodeDiskPressureThresholdPercent?: number | null;
      nodeMetricsTtlMs?: number | null;
      nodeCpuScoreWeightPercent?: number | null;
      nodeMemoryScoreWeightPercent?: number | null;
      warmNodeTimeoutMs?: number | null;
    } | null;
    /** Raw resolved inputs retained for audit and provenance. */
    resourceRequirements?: ResourceRequirements | null;
    /** Immutable scheduler reservation used for node selection and final workspace placement. */
    resolvedReservation: ResolvedResourceReservation;
    /** Effective one-pool capacity selection for VM task placement. */
    capacityPoolSelection?: TaskStartCapacityPoolSelection | null;
    /** Where the VM size came from in the precedence chain. */
    vmSizeSource?: ResourceRequirementsSource | 'explicit' | null;
    /** Existing sleeping chat whose snapshot is restored before queued prompt delivery. */
    resumeSnapshotChatSessionId?: string | null;
    /** First prompt for a restored session when nothing is queued for it. */
    restoredSessionPrompt?: string | null;
    /** Resource-eviction identity that must remain current through replacement allocation. */
    evictionFence?: {
      workspaceId: string;
      nodeId: string;
      generation: string | null;
    } | null;
    /** Original parent whose live status authorizes this snapshot-recovery runner. */
    recoverySourceTaskId?: string | null;
    recoveryAttemptId?: string | null;
    /** Original attempt whose runtime deletion fences this replacement. */
    retrySourceTaskId?: string | null;
    /** Optional durable lifecycle guard for reserved first-start submissions. */
    startGuard?: TaskRunnerStartGuard | null;
    /** Event wake batch/subscription identity that must still authorize guarded recovery. */
    projectEventWakeGuard?: ProjectEventWakeRecoveryGuard | null;
    /** Member whose continued write permission authorizes a scheduled wake. */
    recoveryRequiredProjectMemberId?: string | null;
  },
  options: { reactivate?: boolean } = {}
): Promise<void> {
  const deletionSourceTaskId = input.retrySourceTaskId ?? input.recoverySourceTaskId ?? null;
  if (deletionSourceTaskId && deletionSourceTaskId !== input.taskId) {
    await assertReplacementDeletionConfirmed(env, {
      sourceTaskId: deletionSourceTaskId,
      projectId: input.projectId,
      userId: input.userId,
    });
  }
  const stub = getStub(env, input.taskId);
  const capacityPoolSelection = capacityPoolSelectionForStart(input);
  const initialCapacityCandidate = capacityPoolSelection?.candidates[0] ?? null;

  const startInput: StartTaskInput = {
    taskId: input.taskId,
    projectId: input.projectId,
    userId: input.userId,
    config: {
      vmSize: input.vmSize,
      vmLocation: initialCapacityCandidate?.location ?? input.vmLocation,
      branch: input.branch,
      defaultBranch: input.defaultBranch ?? input.branch,
      preferredNodeId: input.preferredNodeId ?? null,
      excludedNodeId: input.excludedNodeId ?? null,
      userName: input.userName ?? null,
      userEmail: input.userEmail ?? null,
      githubId: input.githubId ?? null,
      taskTitle: input.taskTitle,
      taskDescription: input.taskDescription ?? null,
      historicalContext: input.historicalContext ?? null,
      repository: input.repository,
      installationId: input.installationId,
      outputBranch: input.outputBranch ?? null,
      projectDefaultVmSize: input.projectDefaultVmSize ?? null,
      chatSessionId: input.chatSessionId ?? null,
      agentType: input.agentType ?? null,
      workspaceProfile: input.workspaceProfile ?? null,
      devcontainerConfigName: input.devcontainerConfigName ?? null,
      cloudProvider: initialCapacityCandidate?.provider ?? input.cloudProvider ?? null,
      providerInstanceType: initialCapacityCandidate?.providerInstanceType ?? null,
      credentialAttributionUserId: input.credentialAttributionUserId ?? input.userId,
      credentialAttributionProjectId:
        (input.credentialAttributionSource ??
          initialCapacityCandidate?.credentialAttributionSource) === 'project'
          ? (input.credentialAttributionProjectId ??
            initialCapacityCandidate?.capacityPoolProjectId ??
            input.projectId)
          : null,
      credentialAttributionSource:
        input.credentialAttributionSource ??
        initialCapacityCandidate?.credentialAttributionSource ??
        'user',
      taskMode: input.taskMode ?? 'task',
      model: input.model ?? null,
      effort: input.effort ?? null,
      permissionMode: input.permissionMode ?? null,
      opencodeProvider: input.opencodeProvider ?? null,
      opencodeBaseUrl: input.opencodeBaseUrl ?? null,
      systemPromptAppend: input.systemPromptAppend ?? null,
      agentProfileHint: input.agentProfileHint ?? null,
      attachments: input.attachments ?? null,
      projectScaling: input.projectScaling ?? null,
      resourceRequirements: input.resourceRequirements ?? null,
      resolvedReservation: input.resolvedReservation,
      capacityPoolSelection,
      vmSizeSource: input.vmSizeSource ?? null,
      resumeSnapshotChatSessionId: input.resumeSnapshotChatSessionId ?? null,
      restoredSessionPrompt: input.restoredSessionPrompt ?? null,
      evictionFence: input.evictionFence ?? null,
      recoverySourceTaskId: input.recoverySourceTaskId ?? null,
      recoveryAttemptId: input.recoveryAttemptId ?? null,
      retrySourceTaskId: input.retrySourceTaskId ?? null,
      startGuard: input.startGuard ?? null,
      projectEventWakeGuard: input.projectEventWakeGuard ?? null,
      recoveryRequiredProjectMemberId: input.recoveryRequiredProjectMemberId ?? null,
    },
  };

  if (options.reactivate === true) {
    await stub.reactivate(startInput);
  } else {
    await stub.start(startInput);
  }

  log.info(
    options.reactivate === true
      ? 'task_runner_do_service.reactivated'
      : 'task_runner_do_service.started',
    {
      taskId: input.taskId,
      projectId: input.projectId,
    }
  );
}

/**
 * Notify the TaskRunner DO that a workspace is ready (or has errored).
 * Called from the workspace ready callback route.
 */
export async function advanceTaskRunnerWorkspaceReady(
  env: Env,
  taskId: string,
  status: 'running' | 'recovery' | 'error',
  errorMessage: string | null,
  workspaceId: string
): Promise<void> {
  const stub = getStub(env, taskId);

  await stub.advanceWorkspaceReady(status, errorMessage, workspaceId);

  log.info('task_runner_do_service.workspace_ready_advanced', {
    taskId,
    status,
  });
}

/**
 * Notify the TaskRunner DO that the VM agent has started the queued workspace build.
 * Called from the build-started callback route.
 */
export async function notifyTaskRunnerWorkspaceBuildStarted(
  env: Env,
  taskId: string,
  workspaceId: string
): Promise<void> {
  const stub = getStub(env, taskId);

  await stub.notifyWorkspaceBuildStarted(workspaceId);

  log.info('task_runner_do_service.workspace_build_started_notified', {
    taskId,
    workspaceId,
  });
}

/**
 * Get the current state of a TaskRunner DO (for debugging).
 */
export async function getTaskRunnerStatus(env: Env, taskId: string): Promise<unknown> {
  const stub = getStub(env, taskId);

  return stub.getStatus();
}

/**
 * Confirm that TaskRunner initialization committed and repair a missing alarm.
 */
export async function ensureTaskRunnerStarted(
  env: Env,
  taskId: string,
  recoveryAttemptId?: string
): Promise<boolean> {
  const stub = getStub(env, taskId);
  return recoveryAttemptId ? stub.ensureStarted(recoveryAttemptId) : stub.ensureStarted();
}

/**
 * Pull a TaskRunner alarm forward after external capacity/admission changes.
 */
export async function nudgeTaskRunnerDO(
  env: Env,
  taskId: string,
  reason?: string
): Promise<boolean> {
  const stub = getStub(env, taskId);
  return stub.nudge(reason);
}
