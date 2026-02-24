/**
 * Chat persistence service — manages chat session lifecycle and message
 * persistence to the ProjectData Durable Object.
 *
 * Messages are persisted asynchronously (non-blocking) so that the real-time
 * chat flow is not impacted by DO write latency.
 *
 * See: specs/018-project-first-architecture/tasks.md (T025)
 */
import type { Env } from '../index';
import * as projectDataService from './project-data';

/**
 * Create a new chat session in the project's Durable Object.
 * The DO internally records a session.started activity event.
 */
export async function createChatSession(
  env: Env,
  projectId: string,
  workspaceId: string | null,
  topic: string | null
): Promise<string> {
  return projectDataService.createSession(env, projectId, workspaceId, topic);
}

/**
 * Stop a chat session in the project's Durable Object.
 * The DO internally records a session.stopped activity event.
 */
export async function stopChatSession(
  env: Env,
  projectId: string,
  sessionId: string
): Promise<void> {
  return projectDataService.stopSession(env, projectId, sessionId);
}

// Browser-side message persistence removed — messages are now persisted
// exclusively by the VM agent via POST /api/workspaces/:id/messages.
// See: specs/021-task-chat-architecture (US1 — Agent-Side Chat Persistence).
