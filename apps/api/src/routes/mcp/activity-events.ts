import type { Env } from '../../env';
import { log } from '../../lib/logger';
import * as projectDataService from '../../services/project-data';
import type { McpTokenData } from './_helpers';

/**
 * Record a best-effort project activity event for an action an agent took through its workspace
 * MCP token, via the ProjectData `recordActivityEvent` RPC.
 *
 * The chat session id is what lets the event-log cleanup reclaim the row later: it deletes
 * activity events by joining them to their stopped or failed chat session, so a row without one
 * is kept until the emergency storage purge.
 */
export async function recordMcpActivityEvent(
  env: Env,
  tokenData: McpTokenData,
  event: {
    eventType: string;
    taskId: string | null;
    payload: Record<string, unknown>;
    /** Logged, with the error, when the event cannot be recorded. */
    failureLogEvent: string;
  }
): Promise<void> {
  try {
    await projectDataService.recordActivityEvent(
      env,
      tokenData.projectId,
      event.eventType,
      'agent',
      tokenData.agentSessionId ?? tokenData.workspaceId,
      tokenData.workspaceId,
      tokenData.chatSessionId ?? null,
      event.taskId,
      event.payload
    );
  } catch (err) {
    log.warn(event.failureLogEvent, {
      projectId: tokenData.projectId,
      workspaceId: tokenData.workspaceId,
      chatSessionId: tokenData.chatSessionId,
      contextType: tokenData.contextType,
      taskId: event.taskId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
