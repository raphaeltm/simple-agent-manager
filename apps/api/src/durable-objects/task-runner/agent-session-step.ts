/**
 * Agent session step handler for the TaskRunner DO.
 *
 * Handles the agent_session step: creating the session, generating MCP token,
 * and starting the agent with the initial prompt.
 */
import { log } from '../../lib/logger';
import {
  buildSamBootstrapInstructions,
  buildVisibleInitialPrompt,
} from '../../services/agent-bootstrap-prompt';
import type { SamAwareAgentStartResult } from '../../services/agent-session-bootstrap';
import { parseProviderLimitWait } from '../../services/provider-limit-policy';
import { getRecoverySourceTaskGuard } from './helpers';
import { transitionToInProgress } from './in-progress-transition';
import { prepareSnapshotRestoreAttempt } from './snapshot-restore-retry';
import type { TaskRunnerContext, TaskRunnerState } from './types';

export function buildTaskAgentSessionLabel(taskTitle: string): string {
  return `Task: ${taskTitle.slice(0, 40)}`;
}

export function buildTaskInitialPrompt(state: TaskRunnerState): string {
  return buildVisibleTaskInitialPrompt(state);
}

export function buildInjectedInstructions(): string {
  return buildSamBootstrapInstructions({ contextType: 'task' });
}

function buildVisibleTaskInitialPrompt(state: TaskRunnerState): string {
  if (state.config.historicalContext) {
    return state.config.taskDescription || state.config.taskTitle;
  }
  return buildVisibleInitialPrompt({
    message: state.config.taskDescription || state.config.taskTitle,
    attachments: state.config.attachments,
    systemPromptAppend: state.config.systemPromptAppend,
  });
}

/**
 * A session the wake restored never received the wake's first prompt (`initialPromptSent`), and
 * nothing is queued for it. Queue the continue prompt once the chat points at this workspace
 * (the ProjectData wake), and before `agentStarted` is written: a retry after that write skips
 * bootstrap, and with it this step. The VM wake handoff hold (`isVmWakeHandoffPending`) delivers
 * it only after `transitionToInProgress` commits.
 */
async function queueRestoredSessionPromptIfNeeded(
  state: TaskRunnerState,
  rc: TaskRunnerContext,
  started: Pick<SamAwareAgentStartResult, 'agentSessionId' | 'initialPromptSent'> | null
): Promise<void> {
  const prompt = state.config.restoredSessionPrompt;
  // `initialPromptSent` is false only after a snapshot restore, so the wake's chat is set.
  const chatSessionId = state.config.resumeSnapshotChatSessionId;
  if (!started || started.initialPromptSent || !prompt || !chatSessionId) return;
  await rc.assertRecoveryAuthority(state);
  const { queueRestoredSessionPrompt } = await import('../../services/restored-session-prompt');
  await queueRestoredSessionPrompt(rc.env, {
    projectId: state.projectId,
    taskId: state.taskId,
    chatSessionId,
    agentSessionId: started.agentSessionId,
    prompt,
  });
}

export async function handleAgentSession(
  state: TaskRunnerState,
  rc: TaskRunnerContext
): Promise<void> {
  await rc.updateD1ExecutionStep(state.taskId, 'agent_session');

  if (!state.stepResults.nodeId || !state.stepResults.workspaceId) {
    throw new Error('Missing nodeId or workspaceId for agent session creation');
  }

  let sessionId = state.stepResults.agentSessionId;

  // Step 1: Create the agent session (skip if already created on a previous attempt)
  if (sessionId) {
    const existing = await rc.env.DATABASE.prepare(`SELECT id FROM agent_sessions WHERE id = ?`)
      .bind(sessionId)
      .first<{ id: string }>();

    if (!existing) {
      // StepResults had a sessionId but it's gone from D1 — reset and recreate
      sessionId = null;
      state.stepResults.agentSessionId = null;
      state.stepResults.agentStarted = false;
      await rc.ctx.storage.put('state', state);
    }
  }

  // Step 2: Start the SAM-aware agent session (skip if already started)
  // This two-step approach ensures that if create succeeds but start fails,
  // a retry will skip creation and retry only the start call.
  let stateChanged = false;
  // Set only by the run that started the agent; a retry after `agentStarted` skips bootstrap.
  let started: SamAwareAgentStartResult | null = null;
  if (!state.stepResults.agentStarted) {
    const { drizzle } = await import('drizzle-orm/d1');
    const schema = await import('../../db/schema');
    const { startSamAwareAgentSession } = await import('../../services/agent-session-bootstrap');
    const db = drizzle(rc.env.DATABASE, { schema });
    const agentType = state.config.agentType || rc.env.DEFAULT_TASK_AGENT_TYPE || 'opencode';
    const sourceTaskGuard = getRecoverySourceTaskGuard(state);
    // failTask owns terminal recovery failure; a retry must retain its claim.
    const result = await startSamAwareAgentSession(db, rc.env, {
      nodeId: state.stepResults.nodeId,
      workspaceId: state.stepResults.workspaceId,
      projectId: state.projectId,
      userId: state.userId,
      chatSessionId: state.stepResults.chatSessionId,
      agentSessionId: sessionId,
      // Dispatch resolves the profile hint to its ID before persisting runner state.
      agentProfileId: state.config.agentProfileHint,
      // A previously claimed runner predates this config field. Its newly
      // approved receipt carries the same skill checked at every authority fence.
      skillId:
        state.config.skillId ??
        parseProviderLimitWait(state.config.providerLimitRecoveryApproval?.receipt)?.ownerOverride
          ?.skillId ??
        null,
      label: buildTaskAgentSessionLabel(state.config.taskTitle),
      agentType,
      visibleInitialPrompt: buildVisibleTaskInitialPrompt(state),
      historicalContext: state.config.historicalContext
        ? buildVisibleInitialPrompt({
            message: state.config.historicalContext,
            attachments: state.config.attachments,
            systemPromptAppend: state.config.systemPromptAppend,
          })
        : undefined,
      restoreSnapshotChatSessionId: state.config.resumeSnapshotChatSessionId,
      promptKind: 'task',
      taskContext: {
        taskId: state.taskId,
        taskMode: state.config.taskMode,
        outputBranch: state.config.outputBranch,
      },
      overrides: {
        model: state.config.model,
        effort: state.config.effort,
        permissionMode: state.config.permissionMode,
        opencodeProvider: state.config.opencodeProvider,
        opencodeBaseUrl: state.config.opencodeBaseUrl,
      },
      existingMcpToken: state.stepResults.mcpToken,
      onAgentSessionId: async (agentSessionId) => {
        state.stepResults.agentSessionId = agentSessionId;
        await rc.ctx.storage.put('state', state);
      },
      onMcpToken: async (mcpToken) => {
        const previousToken = state.stepResults.mcpToken;
        state.stepResults.mcpToken = mcpToken;
        try {
          await rc.ctx.storage.put('state', state);
        } catch (error) {
          // Bootstrap revokes a rejected handoff; retries must not reuse it.
          state.stepResults.mcpToken = previousToken;
          throw error;
        }
      },
      runPhase: async (phase, run) => {
        if (phase === 'restore_acp_session') await prepareSnapshotRestoreAttempt(state, rc);
        return run();
      },
      beforeExternalMutation: async () => {
        await rc.assertRecoveryAuthority(state);
      },
      sourceTaskGuard,
      actor: {
        type: 'system',
        id: 'task-runner',
        reasonPrefix: 'Task runner agent session',
      },
    });

    state.stepResults.agentSessionId = result.agentSessionId;
    state.stepResults.mcpToken = result.mcpToken;
    state.stepResults.agentStarted = true;
    if (state.config.resumeSnapshotChatSessionId) {
      state.stepResults.snapshotRestoreComplete = result.snapshotRestore === 'restored';
    }
    stateChanged = true;
    started = result;

    log.info('task_runner_do.step.agent_session_started', {
      taskId: state.taskId,
      agentSessionId: sessionId,
      agentType,
      mcpServerConfigured: true,
    });
  }

  if (state.config.resumeSnapshotChatSessionId) {
    const { drizzle } = await import('drizzle-orm/d1');
    const schema = await import('../../db/schema');
    const { completeSessionSnapshotRecoveryGeneration } =
      await import('../../services/session-snapshots');
    const projectDataService = await import('../../services/project-data');
    // Link the runtime while keeping the public chat sleeping until the guarded
    // task handoff commits. If this RPC fails, the snapshot remains claimable and a
    // later recovery attempt can safely converge instead of becoming stranded.
    await rc.assertRecoveryAuthority(state);
    const sessionWoken = await projectDataService.wakeSessionForSnapshotRecovery(
      rc.env,
      state.projectId,
      state.config.resumeSnapshotChatSessionId,
      state.stepResults.workspaceId,
      state.taskId,
      { deferActivation: true, recoveryAttemptId: state.config.recoveryAttemptId }
    );
    if (!sessionWoken) {
      throw Object.assign(
        new Error('Strict session restore succeeded but lifecycle recovery commit refused'),
        { permanent: true }
      );
    }
    await rc.assertRecoveryAuthority(state);
    const snapshotDb = drizzle(rc.env.DATABASE, { schema });
    const restored = await completeSessionSnapshotRecoveryGeneration(
      snapshotDb,
      state.config.resumeSnapshotChatSessionId,
      state.taskId,
      state.stepResults.workspaceId,
      state.config.recoverySourceTaskId ?? undefined,
      state.config.recoveryAttemptId ?? undefined
    );
    if (!restored) {
      throw Object.assign(
        new Error('Strict session restore succeeded but lifecycle recovery commit refused'),
        { permanent: true }
      );
    }
    // Keep exactly what was restored: the commit below stamps the source receipt of this
    // generation, and a successor capture may replace the row's live generation first. A
    // retry after a crash keeps the first value.
    if (
      state.stepResults.snapshotRestoreComplete === true &&
      state.stepResults.restoredSnapshotGeneration === undefined
    ) {
      state.stepResults.restoredSnapshotGeneration = restored.snapshotGeneration;
      stateChanged = true;
    }
  }

  await queueRestoredSessionPromptIfNeeded(state, rc, started);

  if (stateChanged) {
    await rc.ctx.storage.put('state', state);
  }

  await rc.assertRecoveryAuthority(state);
  await transitionToInProgress(state, rc);

  if (state.currentStep === 'running' && state.config.resumeSnapshotChatSessionId) {
    const restoredChatSessionId = state.config.resumeSnapshotChatSessionId;
    // Keep the revocable marker through the source-authorized D1 transition.
    // If the DO crashes after that transition, authorization treats the
    // restored+in_progress pair as committed so a retry can converge here.
    state.config.resumeSnapshotChatSessionId = null;
    state.config.recoverySourceTaskId = null;
    // The fence guarded replacement allocation, which is now committed. It requires the
    // source to stay `evicted`, so it must be gone before that source is released below.
    state.config.evictionFence = null;
    await rc.ctx.storage.put('state', state);
    // The restored generation now lives here; release the retired source's files. The
    // commit already stamped its receipt, so the stale-workspace sweep re-queues the source
    // if this best-effort release is lost. A degraded restore releases nothing.
    if (state.stepResults.snapshotRestoreComplete !== true) return;
    const { releaseRestoredSourceWorkspaces } =
      await import('../../services/workspace-preservation-receipt');
    await releaseRestoredSourceWorkspaces(rc.env, {
      chatSessionId: restoredChatSessionId,
      restoredWorkspaceId: state.stepResults.workspaceId,
      snapshotGeneration: state.stepResults.restoredSnapshotGeneration,
    }).catch((error: unknown) => {
      log.warn('task_runner.restored_source_release_failed', {
        taskId: state.taskId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
}
