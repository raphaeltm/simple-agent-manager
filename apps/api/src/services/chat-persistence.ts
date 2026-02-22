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

/**
 * Persist a chat message asynchronously (non-blocking).
 * Returns immediately; DO write happens in the background via waitUntil.
 *
 * When called from a route handler, pass executionCtx to use waitUntil.
 * When no executionCtx is available, the write is awaited directly.
 */
export function persistMessageAsync(
  env: Env,
  projectId: string,
  sessionId: string,
  role: string,
  content: string,
  toolMetadata: Record<string, unknown> | null,
  executionCtx?: ExecutionContext
): void {
  const doWrite = projectDataService
    .persistMessage(env, projectId, sessionId, role, content, toolMetadata)
    .catch((err) => {
      // Non-blocking: log but don't propagate
      console.error('Chat persistence failed:', err);
    });

  if (executionCtx) {
    executionCtx.waitUntil(doWrite);
  }
  // If no executionCtx, fire-and-forget (promise will resolve independently)
}

/**
 * Persist a chat message synchronously (blocking).
 * Returns the message ID on success.
 */
export async function persistMessage(
  env: Env,
  projectId: string,
  sessionId: string,
  role: string,
  content: string,
  toolMetadata: Record<string, unknown> | null
): Promise<string> {
  return projectDataService.persistMessage(env, projectId, sessionId, role, content, toolMetadata);
}
