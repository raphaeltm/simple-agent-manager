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

export async function linkSessionToWorkspace(
  env: Env,
  projectId: string,
  sessionId: string,
  workspaceId: string
): Promise<void> {
  const stub = await getStub(env, projectId);
  return stub.linkSessionToWorkspace(sessionId, workspaceId);
}

export async function stopSession(
  env: Env,
  projectId: string,
  sessionId: string
): Promise<void> {
  const stub = await getStub(env, projectId);
  return stub.stopSession(sessionId);
}

export async function updateSessionTopic(
  env: Env,
  projectId: string,
  sessionId: string,
  topic: string
): Promise<boolean> {
  const stub = await getStub(env, projectId);
  return stub.updateSessionTopic(sessionId, topic);
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
    sequence?: number;
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
      sequence: m.sequence,
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

export async function getSessionsByTaskIds(
  env: Env,
  projectId: string,
  taskIds: string[]
): Promise<Array<Record<string, unknown>>> {
  const stub = await getStub(env, projectId);
  return stub.getSessionsByTaskIds(taskIds);
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
  before: number | null = null,
  roles?: string[]
): Promise<{ messages: Record<string, unknown>[]; hasMore: boolean }> {
  const stub = await getStub(env, projectId);
  return stub.getMessages(sessionId, limit, before, roles);
}

/** Get total message count for a session, optionally filtered by roles. */
export async function getMessageCount(
  env: Env,
  projectId: string,
  sessionId: string,
  roles?: string[]
): Promise<number> {
  const stub = await getStub(env, projectId);
  return stub.getMessageCount(sessionId, roles);
}

/** Search messages across sessions by keyword. */
export async function searchMessages(
  env: Env,
  projectId: string,
  query: string,
  sessionId: string | null = null,
  roles: string[] | null = null,
  limit: number = 10,
): Promise<Array<{
  id: string;
  sessionId: string;
  role: string;
  snippet: string;
  createdAt: number;
  sessionTopic: string | null;
  sessionTaskId: string | null;
}>> {
  const stub = await getStub(env, projectId);
  return stub.searchMessages(query, sessionId, roles, limit);
}

/** Materialize all stopped sessions that haven't been indexed yet. */
export async function materializeAllStopped(
  env: Env,
  projectId: string,
  limit: number = 50,
): Promise<{ materialized: number; errors: number; remaining: number }> {
  const stub = await getStub(env, projectId);
  return stub.materializeAllStopped(limit);
}

export async function getCleanupAt(
  env: Env,
  projectId: string,
  sessionId: string
): Promise<number | null> {
  const stub = await getStub(env, projectId);
  return stub.getCleanupAt(sessionId);
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
// Session–Idea Linking (many-to-many)
// =========================================================================

export async function linkSessionIdea(
  env: Env,
  projectId: string,
  sessionId: string,
  taskId: string,
  context: string | null = null
): Promise<void> {
  const stub = await getStub(env, projectId);
  return stub.linkSessionIdea(sessionId, taskId, context);
}

export async function unlinkSessionIdea(
  env: Env,
  projectId: string,
  sessionId: string,
  taskId: string
): Promise<void> {
  const stub = await getStub(env, projectId);
  return stub.unlinkSessionIdea(sessionId, taskId);
}

export async function getIdeasForSession(
  env: Env,
  projectId: string,
  sessionId: string
): Promise<Array<{ taskId: string; context: string | null; createdAt: number }>> {
  const stub = await getStub(env, projectId);
  return stub.getIdeasForSession(sessionId);
}

export async function getSessionsForIdea(
  env: Env,
  projectId: string,
  taskId: string
): Promise<Array<{
  sessionId: string;
  topic: string | null;
  status: string;
  context: string | null;
  linkedAt: number;
}>> {
  const stub = await getStub(env, projectId);
  return stub.getSessionsForIdea(taskId);
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
// ACP Sessions (Spec 027 — DO-Owned Lifecycle)
// =========================================================================

import type {
  AcpSession,
  AcpSessionStatus,
  AcpSessionEventActorType,
} from '@simple-agent-manager/shared';

export async function createAcpSession(
  env: Env,
  projectId: string,
  chatSessionId: string,
  initialPrompt: string | null,
  agentType: string | null,
  parentSessionId: string | null = null,
  forkDepth: number = 0
): Promise<AcpSession> {
  const stub = await getStub(env, projectId);
  return stub.createAcpSession({
    chatSessionId,
    initialPrompt,
    agentType,
    parentSessionId,
    forkDepth,
  });
}

export async function getAcpSession(
  env: Env,
  projectId: string,
  sessionId: string
): Promise<AcpSession | null> {
  const stub = await getStub(env, projectId);
  return stub.getAcpSession(sessionId);
}

export async function listAcpSessions(
  env: Env,
  projectId: string,
  opts?: {
    chatSessionId?: string;
    status?: AcpSessionStatus;
    nodeId?: string;
    limit?: number;
    offset?: number;
  }
): Promise<{ sessions: AcpSession[]; total: number }> {
  const stub = await getStub(env, projectId);
  return stub.listAcpSessions(opts);
}

export async function transitionAcpSession(
  env: Env,
  projectId: string,
  sessionId: string,
  toStatus: AcpSessionStatus,
  opts: {
    actorType: AcpSessionEventActorType;
    actorId?: string | null;
    reason?: string | null;
    metadata?: Record<string, unknown> | null;
    workspaceId?: string;
    nodeId?: string;
    acpSdkSessionId?: string;
    errorMessage?: string;
  }
): Promise<AcpSession> {
  const stub = await getStub(env, projectId);
  return stub.transitionAcpSession(sessionId, toStatus, opts);
}

export async function updateAcpSessionHeartbeat(
  env: Env,
  projectId: string,
  sessionId: string,
  nodeId: string
): Promise<void> {
  const stub = await getStub(env, projectId);
  return stub.updateHeartbeat(sessionId, nodeId);
}

export async function forkAcpSession(
  env: Env,
  projectId: string,
  sessionId: string,
  contextSummary: string
): Promise<AcpSession> {
  const stub = await getStub(env, projectId);
  return stub.forkAcpSession(sessionId, contextSummary);
}

export async function getAcpSessionLineage(
  env: Env,
  projectId: string,
  sessionId: string
): Promise<AcpSession[]> {
  const stub = await getStub(env, projectId);
  return stub.getAcpSessionLineage(sessionId);
}

export async function listAcpSessionsByNode(
  env: Env,
  projectId: string,
  nodeId: string,
  statuses: AcpSessionStatus[]
): Promise<AcpSession[]> {
  const stub = await getStub(env, projectId);
  return stub.listAcpSessionsByNode(nodeId, statuses);
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
// Workspace Activity Tracking
// =========================================================================

/**
 * Record terminal activity for a workspace. Called when a terminal token
 * is requested or the frontend sends a terminal heartbeat.
 */
export async function updateTerminalActivity(
  env: Env,
  projectId: string,
  workspaceId: string,
  sessionId: string | null
): Promise<void> {
  const stub = await getStub(env, projectId);
  await stub.updateTerminalActivity(workspaceId, sessionId);
}

/**
 * Clean up workspace activity tracking for a workspace. Called when a workspace
 * is stopped or deleted to prevent phantom idle checks.
 */
export async function cleanupWorkspaceActivity(
  env: Env,
  projectId: string,
  workspaceId: string
): Promise<void> {
  const stub = await getStub(env, projectId);
  await stub.cleanupWorkspaceActivity(workspaceId);
}

// =========================================================================
// Cached Commands
// =========================================================================

export async function cacheCommands(
  env: Env,
  projectId: string,
  agentType: string,
  cmds: Array<{ name: string; description: string }>,
): Promise<void> {
  const stub = await getStub(env, projectId);
  await stub.cacheCommands(agentType, cmds);
}

export async function getCachedCommands(
  env: Env,
  projectId: string,
  agentType?: string,
): Promise<Array<{ agentType: string; name: string; description: string; updatedAt: number }>> {
  const stub = await getStub(env, projectId);
  return stub.getCachedCommands(agentType);
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
