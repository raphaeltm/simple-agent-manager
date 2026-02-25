/**
 * Service layer for interacting with the per-project Durable Object.
 *
 * Provides typed wrapper methods that resolve the DO stub from a projectId
 * and forward calls to the ProjectData DO via RPC.
 *
 * See: specs/018-project-first-architecture/research.md (Decision 3)
 */
import type { Env } from '../index';
import type { ProjectData } from '../durable-objects/project-data';

/**
 * Get a typed DO stub for the given project and ensure the DO knows its projectId.
 * Uses `idFromName(projectId)` for deterministic mapping.
 *
 * `ensureProjectId` stores the projectId in DO SQLite so that internal methods
 * like `syncSummaryToD1` can reference the correct D1 row. This is necessary
 * because `DurableObjectId.toString()` returns a hex ID, not the original name.
 */
async function getStub(env: Env, projectId: string): Promise<DurableObjectStub<ProjectData>> {
  const id = env.PROJECT_DATA.idFromName(projectId);
  const stub = env.PROJECT_DATA.get(id) as DurableObjectStub<ProjectData>;
  await stub.ensureProjectId(projectId);
  return stub;
}

// =========================================================================
// Chat Sessions
// =========================================================================

export async function createSession(
  env: Env,
  projectId: string,
  workspaceId: string | null,
  topic: string | null,
  taskId: string | null = null
): Promise<string> {
  const stub = await getStub(env, projectId);
  return stub.createSession(workspaceId, topic, taskId);
}

export async function stopSession(
  env: Env,
  projectId: string,
  sessionId: string
): Promise<void> {
  const stub = await getStub(env, projectId);
  return stub.stopSession(sessionId);
}

export async function persistMessage(
  env: Env,
  projectId: string,
  sessionId: string,
  role: string,
  content: string,
  toolMetadata: Record<string, unknown> | null
): Promise<string> {
  const stub = await getStub(env, projectId);
  return stub.persistMessage(
    sessionId,
    role,
    content,
    toolMetadata ? JSON.stringify(toolMetadata) : null
  );
}

export async function persistMessageBatch(
  env: Env,
  projectId: string,
  sessionId: string,
  messages: Array<{
    messageId: string;
    role: string;
    content: string;
    toolMetadata: Record<string, unknown> | null;
    timestamp: string;
  }>
): Promise<{ persisted: number; duplicates: number }> {
  const stub = await getStub(env, projectId);
  return stub.persistMessageBatch(
    sessionId,
    messages.map((m) => ({
      messageId: m.messageId,
      role: m.role,
      content: m.content,
      toolMetadata: m.toolMetadata ? JSON.stringify(m.toolMetadata) : null,
      timestamp: m.timestamp,
    }))
  );
}

export async function listSessions(
  env: Env,
  projectId: string,
  status: string | null = null,
  limit: number = 20,
  offset: number = 0,
  taskId: string | null = null
): Promise<{ sessions: Record<string, unknown>[]; total: number }> {
  const stub = await getStub(env, projectId);
  return stub.listSessions(status, limit, offset, taskId);
}

export async function getSession(
  env: Env,
  projectId: string,
  sessionId: string
): Promise<Record<string, unknown> | null> {
  const stub = await getStub(env, projectId);
  return stub.getSession(sessionId);
}

export async function getMessages(
  env: Env,
  projectId: string,
  sessionId: string,
  limit: number = 100,
  before: number | null = null
): Promise<{ messages: Record<string, unknown>[]; hasMore: boolean }> {
  const stub = await getStub(env, projectId);
  return stub.getMessages(sessionId, limit, before);
}

export async function markAgentCompleted(
  env: Env,
  projectId: string,
  sessionId: string
): Promise<void> {
  const stub = await getStub(env, projectId);
  return stub.markAgentCompleted(sessionId);
}

// =========================================================================
// Idle Cleanup Schedule
// =========================================================================

export async function scheduleIdleCleanup(
  env: Env,
  projectId: string,
  sessionId: string,
  workspaceId: string,
  taskId: string | null
): Promise<{ cleanupAt: number }> {
  const stub = await getStub(env, projectId);
  return stub.scheduleIdleCleanup(sessionId, workspaceId, taskId);
}

export async function cancelIdleCleanup(
  env: Env,
  projectId: string,
  sessionId: string
): Promise<void> {
  const stub = await getStub(env, projectId);
  return stub.cancelIdleCleanup(sessionId);
}

export async function resetIdleCleanup(
  env: Env,
  projectId: string,
  sessionId: string
): Promise<{ cleanupAt: number }> {
  const stub = await getStub(env, projectId);
  return stub.resetIdleCleanup(sessionId);
}

// =========================================================================
// Activity Events
// =========================================================================

export async function recordActivityEvent(
  env: Env,
  projectId: string,
  eventType: string,
  actorType: string,
  actorId: string | null,
  workspaceId: string | null,
  sessionId: string | null,
  taskId: string | null,
  payload: Record<string, unknown> | null
): Promise<string> {
  const stub = await getStub(env, projectId);
  return stub.recordActivityEvent(
    eventType,
    actorType,
    actorId,
    workspaceId,
    sessionId,
    taskId,
    payload ? JSON.stringify(payload) : null
  );
}

export async function listActivityEvents(
  env: Env,
  projectId: string,
  eventType: string | null = null,
  limit: number = 50,
  before: number | null = null
): Promise<{ events: Record<string, unknown>[]; hasMore: boolean }> {
  const stub = await getStub(env, projectId);
  return stub.listActivityEvents(eventType, limit, before);
}

// =========================================================================
// Summary
// =========================================================================

export async function getSummary(
  env: Env,
  projectId: string
): Promise<{ lastActivityAt: string; activeSessionCount: number }> {
  const stub = await getStub(env, projectId);
  return stub.getSummary();
}

// =========================================================================
// WebSocket
// =========================================================================

/**
 * Forward a WebSocket upgrade request to the project's DO.
 * Returns the Response from the DO (101 Switching Protocols).
 */
export async function forwardWebSocket(
  env: Env,
  projectId: string,
  request: Request
): Promise<Response> {
  const stub = await getStub(env, projectId);
  const url = new URL(request.url);
  url.pathname = '/ws';
  return stub.fetch(new Request(url.toString(), request));
}
