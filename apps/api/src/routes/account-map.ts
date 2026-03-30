/**
 * Account Map API route.
 *
 * Returns aggregated entity data (projects, nodes, workspaces, sessions,
 * tasks) and their relationships for the authenticated user.
 * Used by the Account Map visualization page.
 *
 * Performance note: this endpoint fans out to one ProjectData DO per project
 * to fetch sessions. For accounts with many projects, this can be slow on
 * cold DOs (~5-20ms each). KV caching (30s TTL) absorbs repeated reads.
 */
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import type { Env } from '../index';
import * as schema from '../db/schema';
import { getUserId, requireAuth, requireApproved } from '../middleware/auth';
import * as projectDataService from '../services/project-data';

/** Default max entities per type from D1. Configurable via ACCOUNT_MAP_MAX_ENTITIES. */
const DEFAULT_MAX_ENTITIES = 200;

/** Max sessions fetched per project from DO. Configurable via ACCOUNT_MAP_MAX_SESSIONS_PER_PROJECT. */
const DEFAULT_MAX_SESSIONS_PER_PROJECT = 20;

/** KV cache TTL in seconds. Configurable via ACCOUNT_MAP_CACHE_TTL_SECONDS. */
const DEFAULT_CACHE_TTL_SECONDS = 30;

interface SessionSummary {
  id: string;
  projectId: string;
  topic: string | null;
  status: string;
  messageCount: number;
  workspaceId: string | null;
  taskId: string | null;
}

interface Relationship {
  source: string;
  target: string;
  type: string;
  active: boolean;
}

const accountMapRoutes = new Hono<{ Bindings: Env }>();

accountMapRoutes.use('/*', requireAuth(), requireApproved());

accountMapRoutes.get('/', async (c) => {
  const userId = getUserId(c);

  const parsedMax = parseInt(c.env.ACCOUNT_MAP_MAX_ENTITIES ?? '', 10);
  const maxEntities = Number.isFinite(parsedMax) && parsedMax > 0
    ? parsedMax
    : DEFAULT_MAX_ENTITIES;

  const parsedSessionCap = parseInt(c.env.ACCOUNT_MAP_MAX_SESSIONS_PER_PROJECT ?? '', 10);
  const maxSessionsPerProject = Number.isFinite(parsedSessionCap) && parsedSessionCap > 0
    ? parsedSessionCap
    : DEFAULT_MAX_SESSIONS_PER_PROJECT;

  const cacheTtl = parseInt(c.env.ACCOUNT_MAP_CACHE_TTL_SECONDS ?? '', 10) || DEFAULT_CACHE_TTL_SECONDS;

  // --- KV cache check ---
  const cacheKey = `account-map:${userId}`;
  const cached = await c.env.KV.get(cacheKey, 'json');
  if (cached) {
    return c.json(cached);
  }

  // --- D1 queries: projects, nodes, workspaces, tasks ---
  const db = drizzle(c.env.DATABASE, { schema });

  const [projectRows, nodeRows, workspaceRows, taskRows] = await Promise.all([
    db
      .select({
        id: schema.projects.id,
        name: schema.projects.name,
        repository: schema.projects.repository,
        status: schema.projects.status,
        lastActivityAt: schema.projects.lastActivityAt,
        activeSessionCount: schema.projects.activeSessionCount,
      })
      .from(schema.projects)
      .where(eq(schema.projects.userId, userId))
      .limit(maxEntities),

    db
      .select({
        id: schema.nodes.id,
        name: schema.nodes.name,
        status: schema.nodes.status,
        vmSize: schema.nodes.vmSize,
        vmLocation: schema.nodes.vmLocation,
        cloudProvider: schema.nodes.cloudProvider,
        ipAddress: schema.nodes.ipAddress,
        healthStatus: schema.nodes.healthStatus,
        lastHeartbeatAt: schema.nodes.lastHeartbeatAt,
        lastMetrics: schema.nodes.lastMetrics,
      })
      .from(schema.nodes)
      .where(eq(schema.nodes.userId, userId))
      .limit(maxEntities),

    db
      .select({
        id: schema.workspaces.id,
        nodeId: schema.workspaces.nodeId,
        projectId: schema.workspaces.projectId,
        displayName: schema.workspaces.displayName,
        branch: schema.workspaces.branch,
        status: schema.workspaces.status,
        vmSize: schema.workspaces.vmSize,
        chatSessionId: schema.workspaces.chatSessionId,
      })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.userId, userId))
      .limit(maxEntities),

    db
      .select({
        id: schema.tasks.id,
        projectId: schema.tasks.projectId,
        workspaceId: schema.tasks.workspaceId,
        title: schema.tasks.title,
        status: schema.tasks.status,
        executionStep: schema.tasks.executionStep,
        priority: schema.tasks.priority,
      })
      .from(schema.tasks)
      .where(eq(schema.tasks.userId, userId))
      .limit(maxEntities),
  ]);

  // --- Fan out to ProjectData DOs for sessions ---
  // Each callback returns its sessions; collected after settlement to avoid shared-array mutation.
  const doResults = await Promise.allSettled(
    projectRows.map(async (project) => {
      const sessionsResult = await projectDataService.listSessions(
        c.env,
        project.id,
        null,
        maxSessionsPerProject,
        0
      );

      return sessionsResult.sessions.map((s): SessionSummary => ({
        id: s.id as string,
        projectId: project.id,
        topic: (s.topic as string) ?? null,
        status: (s.status as string) ?? 'unknown',
        messageCount: (s.messageCount as number) ?? 0,
        workspaceId: (s.workspaceId as string) ?? null,
        taskId: (s.taskId as string) ?? null,
      }));
    })
  );

  const allSessions: SessionSummary[] = [];
  for (const result of doResults) {
    if (result.status === 'fulfilled') {
      allSessions.push(...result.value);
    } else {
      console.warn('AccountMap: failed to fetch DO data:', result.reason);
    }
  }

  // --- Build relationships ---
  const relationships: Relationship[] = [];

  // Project → Workspace
  for (const ws of workspaceRows) {
    if (ws.projectId) {
      relationships.push({
        source: ws.projectId,
        target: ws.id,
        type: 'has_workspace',
        active: ws.status === 'running',
      });
    }
  }

  // Workspace → Node
  for (const ws of workspaceRows) {
    if (ws.nodeId) {
      relationships.push({
        source: ws.id,
        target: ws.nodeId,
        type: 'runs_on',
        active: ws.status === 'running',
      });
    }
  }

  // Project → Session
  for (const session of allSessions) {
    relationships.push({
      source: session.projectId,
      target: session.id,
      type: 'has_session',
      active: session.status === 'running' || session.status === 'active',
    });
  }

  // Session → Workspace
  for (const session of allSessions) {
    if (session.workspaceId) {
      relationships.push({
        source: session.id,
        target: session.workspaceId,
        type: 'session_workspace',
        active: session.status === 'running' || session.status === 'active',
      });
    }
  }

  // Project → Task
  for (const task of taskRows) {
    if (task.projectId) {
      relationships.push({
        source: task.projectId,
        target: task.id,
        type: 'has_task',
        active: task.status === 'in_progress' || task.status === 'queued',
      });
    }
  }

  // Task → Workspace
  for (const task of taskRows) {
    if (task.workspaceId) {
      relationships.push({
        source: task.id,
        target: task.workspaceId,
        type: 'task_workspace',
        active: task.status === 'in_progress',
      });
    }
  }

  const payload = {
    projects: projectRows,
    nodes: nodeRows,
    workspaces: workspaceRows,
    sessions: allSessions,
    tasks: taskRows.map((t) => ({
      id: t.id,
      projectId: t.projectId,
      workspaceId: t.workspaceId,
      title: t.title,
      status: t.status,
      executionStep: t.executionStep,
      priority: t.priority,
    })),
    relationships,
  };

  // --- Cache in KV (fire-and-forget) ---
  void c.env.KV.put(cacheKey, JSON.stringify(payload), { expirationTtl: cacheTtl })
    .catch((err: unknown) => console.warn('AccountMap: KV cache write failed:', err));

  return c.json(payload);
});

export { accountMapRoutes };
