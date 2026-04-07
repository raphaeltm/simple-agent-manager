/**
 * Session inbox drain service — delivers queued inbox messages to parent agent sessions.
 *
 * Called after a parent session goes idle (e.g., after message batch persistence).
 * Concatenates pending messages into a single prompt and sends to the parent agent.
 *
 * Urgent messages trigger cancel+re-prompt when the agent is busy:
 * 1. Try normal delivery (agent might be idle)
 * 2. If 409 and urgent messages exist: cancel current prompt, wait, retry
 * 3. Normal-priority messages just stay in the inbox for the next cycle
 */
import type { ProjectData } from '../durable-objects/project-data';
import type { Env } from '../index';
import { log } from '../lib/logger';
import { parsePositiveInt } from '../lib/route-helpers';
import { DEFAULT_ORCHESTRATOR_INBOX_DRAIN_BATCH_SIZE } from '../routes/mcp/_helpers';
import { cancelAgentSessionOnNode, sendPromptToAgentOnNode } from './node-agent';

/** Default wait time (ms) between cancel and re-prompt attempt. */
const DEFAULT_ORCHESTRATOR_CANCEL_SETTLE_MS = 2000;

/** Default max cancel+retry attempts for urgent messages. */
const DEFAULT_ORCHESTRATOR_URGENT_RETRY_ATTEMPTS = 2;

export interface DrainResult {
  delivered: number;
  pending: number;
  skipped: boolean;
  error?: string;
}

/**
 * Resolve parent task's session context from D1.
 * Returns null if the parent task has no workspace or session.
 */
export async function resolveParentSessionContext(
  db: D1Database,
  parentTaskId: string,
): Promise<{
  parentProjectId: string;
  parentWorkspaceId: string;
  parentChatSessionId: string;
  parentNodeId: string;
  parentUserId: string;
} | null> {
  const row = await db.prepare(`
    SELECT t.project_id, t.user_id, w.id as workspace_id, w.chat_session_id, w.node_id
    FROM tasks t
    LEFT JOIN workspaces w ON w.id = t.workspace_id
    WHERE t.id = ?
  `).bind(parentTaskId).first<{
    project_id: string;
    user_id: string;
    workspace_id: string | null;
    chat_session_id: string | null;
    node_id: string | null;
  }>();

  if (!row || !row.workspace_id || !row.chat_session_id || !row.node_id) {
    return null;
  }

  return {
    parentProjectId: row.project_id,
    parentWorkspaceId: row.workspace_id,
    parentChatSessionId: row.chat_session_id,
    parentNodeId: row.node_id,
    parentUserId: row.user_id,
  };
}

/**
 * Drain pending inbox messages for a session, delivering them as a prompt to the parent agent.
 *
 * For urgent messages: if the agent is busy, attempts cancel+re-prompt to deliver immediately.
 * For normal messages: if the agent is busy, leaves them in the inbox for retry on the next cycle.
 */
export async function drainSessionInbox(
  projectId: string,
  sessionId: string,
  env: Env,
): Promise<DrainResult> {
  try {
    // Get the ProjectData DO for this project
    const doId = env.PROJECT_DATA.idFromName(projectId);
    const projectData = env.PROJECT_DATA.get(doId) as DurableObjectStub<ProjectData>;

    // Get pending messages
    const batchSize = parsePositiveInt(env.ORCHESTRATOR_INBOX_DRAIN_BATCH_SIZE, DEFAULT_ORCHESTRATOR_INBOX_DRAIN_BATCH_SIZE);
    const messages = await projectData.getPendingInboxMessages(sessionId, batchSize);

    if (messages.length === 0) {
      return { delivered: 0, pending: 0, skipped: false };
    }

    // Look up the workspace and node for this session
    const sessionRow = await env.DATABASE.prepare(
      'SELECT w.id as workspace_id, w.node_id, w.user_id FROM workspaces w WHERE w.chat_session_id = ?',
    ).bind(sessionId).first<{ workspace_id: string; node_id: string; user_id: string }>();

    if (!sessionRow) {
      log.warn('inbox_drain.no_workspace_for_session', { projectId, sessionId });
      return { delivered: 0, pending: messages.length, skipped: true, error: 'no_workspace' };
    }

    // Check if the parent task is still active
    const taskRow = await env.DATABASE.prepare(
      "SELECT id FROM tasks WHERE workspace_id = ? AND status IN ('in_progress', 'delegated', 'awaiting_followup')",
    ).bind(sessionRow.workspace_id).first<{ id: string }>();

    if (!taskRow) {
      log.info('inbox_drain.parent_task_not_active', { projectId, sessionId });
      // Mark all messages as delivered since the parent can't process them
      const ids = messages.map((m) => m.id);
      await projectData.markInboxDelivered(ids);
      return { delivered: 0, pending: 0, skipped: true, error: 'parent_not_active' };
    }

    // Check if any messages are urgent
    const hasUrgent = messages.some((m) => m.priority === 'urgent');

    // Build the prompt from pending messages
    const prompt = formatInboxPrompt(messages);

    // Attempt delivery to the parent agent
    try {
      await sendPromptToAgentOnNode(
        sessionRow.node_id,
        sessionRow.workspace_id,
        sessionId,
        prompt,
        env,
        sessionRow.user_id,
      );

      // Success — mark messages as delivered
      const ids = messages.map((m) => m.id);
      await projectData.markInboxDelivered(ids);

      log.info('inbox_drain.delivered', {
        projectId,
        sessionId,
        count: messages.length,
      });

      return { delivered: messages.length, pending: 0, skipped: false };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);

      // 409 = agent is busy
      if (errMsg.includes('409')) {
        // If there are urgent messages, try cancel+re-prompt
        if (hasUrgent) {
          return attemptUrgentInterrupt(
            projectId,
            sessionId,
            sessionRow,
            messages,
            prompt,
            projectData,
            env,
          );
        }

        // Normal messages — leave in inbox for next cycle
        log.info('inbox_drain.agent_busy', { projectId, sessionId, pending: messages.length });
        return { delivered: 0, pending: messages.length, skipped: true, error: 'agent_busy' };
      }

      // Other errors — log and leave for retry
      log.error('inbox_drain.delivery_failed', { projectId, sessionId, error: errMsg });
      return { delivered: 0, pending: messages.length, skipped: true, error: errMsg };
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log.error('inbox_drain.error', { projectId, sessionId, error: errMsg });
    return { delivered: 0, pending: 0, skipped: true, error: errMsg };
  }
}

/**
 * Attempt urgent interrupt delivery: cancel current prompt, wait, then re-prompt.
 * Retries up to ORCHESTRATOR_URGENT_RETRY_ATTEMPTS times.
 */
async function attemptUrgentInterrupt(
  projectId: string,
  sessionId: string,
  sessionRow: { workspace_id: string; node_id: string; user_id: string },
  messages: Array<{ id: string; messageType: string; sourceTaskId: string | null; content: string; priority: string }>,
  prompt: string,
  projectData: DurableObjectStub<ProjectData>,
  env: Env,
): Promise<DrainResult> {
  const cancelSettleMs = parsePositiveInt(
    env.ORCHESTRATOR_CANCEL_SETTLE_MS,
    DEFAULT_ORCHESTRATOR_CANCEL_SETTLE_MS,
  );
  const maxRetries = parsePositiveInt(
    env.ORCHESTRATOR_URGENT_RETRY_ATTEMPTS,
    DEFAULT_ORCHESTRATOR_URGENT_RETRY_ATTEMPTS,
  );

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    log.info('inbox_drain.urgent_interrupt_attempt', {
      projectId,
      sessionId,
      attempt: attempt + 1,
      maxRetries,
    });

    // Cancel the running prompt
    const cancelResult = await cancelAgentSessionOnNode(
      sessionRow.node_id,
      sessionRow.workspace_id,
      sessionId,
      env,
      sessionRow.user_id,
    );

    if (!cancelResult.success && cancelResult.status !== 409) {
      // Cancel failed for a non-409 reason — give up on interrupt
      log.warn('inbox_drain.urgent_cancel_failed', {
        projectId,
        sessionId,
        cancelStatus: cancelResult.status,
      });
      break;
    }

    // Wait for the cancel to settle
    await new Promise((resolve) => setTimeout(resolve, cancelSettleMs));

    // Retry prompt delivery
    try {
      await sendPromptToAgentOnNode(
        sessionRow.node_id,
        sessionRow.workspace_id,
        sessionId,
        prompt,
        env,
        sessionRow.user_id,
      );

      // Success — mark messages as delivered
      const ids = messages.map((m) => m.id);
      await projectData.markInboxDelivered(ids);

      log.info('inbox_drain.urgent_delivered', {
        projectId,
        sessionId,
        count: messages.length,
        attempt: attempt + 1,
      });

      return { delivered: messages.length, pending: 0, skipped: false };
    } catch (retryErr) {
      const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
      if (!retryMsg.includes('409')) {
        // Non-409 error — something else is wrong
        log.error('inbox_drain.urgent_retry_failed', {
          projectId,
          sessionId,
          error: retryMsg,
          attempt: attempt + 1,
        });
        return { delivered: 0, pending: messages.length, skipped: true, error: retryMsg };
      }
      // Still 409 — agent hasn't become idle yet, try again
    }
  }

  // All retries exhausted — leave messages pending for next drain cycle
  log.info('inbox_drain.urgent_exhausted', {
    projectId,
    sessionId,
    pending: messages.length,
  });
  return { delivered: 0, pending: messages.length, skipped: true, error: 'agent_busy_after_cancel' };
}

/**
 * Format inbox messages into a single prompt for delivery to the parent agent.
 */
export function formatInboxPrompt(
  messages: Array<{ messageType: string; sourceTaskId: string | null; content: string; priority: string }>,
): string {
  if (messages.length === 1 && messages[0]) {
    const msg = messages[0];
    return `[Orchestrator Notification — ${formatMessageType(msg.messageType)}${msg.priority === 'urgent' ? ' (URGENT)' : ''}]\n\n${msg.content}`;
  }

  const parts = messages.map((msg, i) => {
    const header = `--- Notification ${i + 1}/${messages.length}: ${formatMessageType(msg.messageType)}${msg.priority === 'urgent' ? ' (URGENT)' : ''} ---`;
    return `${header}\n${msg.content}`;
  });

  return `[Orchestrator: ${messages.length} pending notifications]\n\n${parts.join('\n\n')}`;
}

export function formatMessageType(type: string): string {
  switch (type) {
    case 'child_completed': return 'Child Task Completed';
    case 'child_failed': return 'Child Task Failed';
    case 'child_needs_input': return 'Child Task Needs Input';
    case 'parent_message': return 'Parent Message';
    default: return type;
  }
}
