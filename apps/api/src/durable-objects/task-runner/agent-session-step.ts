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
import { transitionToInProgress } from './state-machine';
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
  return buildVisibleInitialPrompt({
    message: state.config.taskDescription || state.config.taskTitle,
    attachments: state.config.attachments,
    systemPromptAppend: state.config.systemPromptAppend,
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
  if (!state.stepResults.agentStarted) {
    const { drizzle } = await import('drizzle-orm/d1');
    const schema = await import('../../db/schema');
    const { startSamAwareAgentSession } = await import('../../services/agent-session-bootstrap');
    const db = drizzle(rc.env.DATABASE, { schema });
    const agentType = state.config.agentType || rc.env.DEFAULT_TASK_AGENT_TYPE || 'opencode';
    let result;
    try {
      result = await startSamAwareAgentSession(db, rc.env, {
        nodeId: state.stepResults.nodeId,
        workspaceId: state.stepResults.workspaceId,
        projectId: state.projectId,
        userId: state.userId,
        chatSessionId: state.stepResults.chatSessionId,
        agentSessionId: sessionId,
        label: buildTaskAgentSessionLabel(state.config.taskTitle),
        agentType,
        visibleInitialPrompt: buildVisibleTaskInitialPrompt(state),
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
          state.stepResults.mcpToken = mcpToken;
          await rc.ctx.storage.put('state', state);
        },
        actor: {
          type: 'system',
          id: 'task-runner',
          reasonPrefix: 'Task runner agent session',
        },
      });
    } catch (error) {
      if (state.config.resumeSnapshotChatSessionId) {
        const { failSessionSnapshotRecovery } = await import('../../services/session-snapshots');
        await failSessionSnapshotRecovery(
          db,
          rc.env,
          state.config.resumeSnapshotChatSessionId,
          state.taskId,
          error instanceof Error ? error.message : String(error)
        );
      }
      throw error;
    }

    state.stepResults.agentSessionId = result.agentSessionId;
    state.stepResults.mcpToken = result.mcpToken;
    state.stepResults.agentStarted = true;
    stateChanged = true;

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
    const { completeSessionSnapshotRecovery } = await import('../../services/session-snapshots');
    const projectDataService = await import('../../services/project-data');
    // Keep sleepingAt authoritative until the ProjectData lifecycle accepts the
    // idempotent wake. If this RPC fails, the snapshot remains claimable and a
    // later recovery attempt can safely converge instead of becoming stranded.
    const sessionWoken = await projectDataService.wakeSession(
      rc.env,
      state.projectId,
      state.config.resumeSnapshotChatSessionId,
      state.stepResults.workspaceId,
      state.taskId
    );
    if (!sessionWoken) {
      throw new Error('Strict session restore succeeded but lifecycle recovery commit failed');
    }
    const recoveryCompleted = await completeSessionSnapshotRecovery(
      drizzle(rc.env.DATABASE, { schema }),
      state.config.resumeSnapshotChatSessionId,
      state.taskId,
      state.stepResults.workspaceId
    );
    if (!recoveryCompleted) {
      throw new Error('Strict session restore succeeded but lifecycle recovery commit failed');
    }
    // Recovery is now fully committed in both authoritative stores. Clear the
    // marker before persisting TaskRunner state so later failures on the awake
    // replacement follow ordinary task semantics instead of re-sleeping a
    // snapshot whose sleepingAt claim has already been cleared.
    state.config.resumeSnapshotChatSessionId = null;
    stateChanged = true;
  }

  if (stateChanged) {
    await rc.ctx.storage.put('state', state);
  }

  await transitionToInProgress(state, rc);
}
