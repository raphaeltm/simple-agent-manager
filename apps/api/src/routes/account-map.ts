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
import { isStrongLinkRelation } from '@simple-agent-manager/shared';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { getUserId, requireApproved, requireAuth } from '../middleware/auth';
import { ideaTaskPredicateSql } from '../operations/idea-core';
import { listLinksForTargets } from '../operations/link-core';
import { resolveAdminSettingDetailsMany } from '../services/admin-settings';
import { listAgentActivityTasks } from '../services/agent-activity';
import * as projectDataService from '../services/project-data';

/**
 * Statuses considered "active" for each entity type when activeOnly=true.
 * These are intentionally broader than operational gating statuses (e.g.,
 * workspaces/_helpers.ts uses only 'running'|'recovery' for connection gating).
 * The map visualization includes transitional states so users can see resources
 * that are starting up or shutting down.
 */
const ACTIVE_NODE_STATUSES = ['pending', 'creating', 'running', 'stopping'];
const ACTIVE_WORKSPACE_STATUSES = ['pending', 'creating', 'running', 'recovery', 'stopping'];
const ACTIVE_SESSION_STATUSES = ['active', 'running'];

/** Default max entities per type from D1. Configurable via ACCOUNT_MAP_MAX_ENTITIES. */
const DEFAULT_MAX_ENTITIES = 200;

/** Max sessions fetched per project from DO. Configurable via ACCOUNT_MAP_MAX_SESSIONS_PER_PROJECT. */
const DEFAULT_MAX_SESSIONS_PER_PROJECT = 20;

/** KV cache TTL in seconds. Configurable via ACCOUNT_MAP_CACHE_TTL_SECONDS. */
const DEFAULT_CACHE_TTL_SECONDS = 30;
const ACCOUNT_MAP_CACHE_VERSION = 'v3';

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
  primary?: boolean;
}

const accountMapRoutes = new Hono<{ Bindings: Env }>();

accountMapRoutes.use('/*', requireAuth(), requireApproved());

accountMapRoutes.get('/', async (c) => {
  const userId = getUserId(c);

  // activeOnly defaults to true — only ?activeOnly=false disables filtering
  const activeOnlyParam = c.req.query('activeOnly');
  const activeOnly = activeOnlyParam !== 'false';

  const parsedMax = Number.parseInt(c.env.ACCOUNT_MAP_MAX_ENTITIES ?? '', 10);
  const maxEntities =
    Number.isFinite(parsedMax) && parsedMax > 0 ? parsedMax : DEFAULT_MAX_ENTITIES;

  const parsedSessionCap = Number.parseInt(c.env.ACCOUNT_MAP_MAX_SESSIONS_PER_PROJECT ?? '', 10);
  const maxSessionsPerProject =
    Number.isFinite(parsedSessionCap) && parsedSessionCap > 0
      ? parsedSessionCap
      : DEFAULT_MAX_SESSIONS_PER_PROJECT;

  const cacheTtl =
    Number.parseInt(c.env.ACCOUNT_MAP_CACHE_TTL_SECONDS ?? '', 10) || DEFAULT_CACHE_TTL_SECONDS;

  // --- KV cache check (separate keys for active vs all) ---
  const cacheKey = `account-map:${ACCOUNT_MAP_CACHE_VERSION}:${userId}:${activeOnly ? 'active' : 'all'}`;
  const cached = await c.env.KV.get(cacheKey, 'json');
  if (cached) {
    return c.json(cached);
  }

  // --- D1 queries: projects, nodes, workspaces, tasks ---
  const db = drizzle(c.env.DATABASE, { schema });

  const [linkProjectCapSetting, ideaCapSetting, batchTargetSetting, perTargetCapSetting] =
    await resolveAdminSettingDetailsMany(c.env, [
      'operations.accountMapLinkProjectCap',
      'operations.accountMapIdeaCap',
      'operations.resourceLinkBatchTargetLimit',
      'operations.resourceLinkBatchPerTargetCap',
    ]);
  const linkProjectCap = Number(linkProjectCapSetting?.value);
  const ideaCap = Math.min(Number(ideaCapSetting?.value), Number(batchTargetSetting?.value));
  const perTargetCap = Number(perTargetCapSetting?.value);

  const [projectCandidates, nodeCandidates, workspaceCandidates, taskRows] = await Promise.all([
    // The existing session fanout includes all returned projects. New idea-link reads
    // below are limited to the most recently active projects only.
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
      .orderBy(desc(schema.projects.lastActivityAt), desc(schema.projects.id))
      .limit(maxEntities + 1),
    // Nodes: filter to active statuses when activeOnly
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
      .where(
        activeOnly
          ? and(eq(schema.nodes.userId, userId), inArray(schema.nodes.status, ACTIVE_NODE_STATUSES))
          : eq(schema.nodes.userId, userId)
      )
      .limit(maxEntities + 1),

    // Workspaces: filter to active statuses when activeOnly
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
      .where(
        activeOnly
          ? and(
              eq(schema.workspaces.userId, userId),
              inArray(schema.workspaces.status, ACTIVE_WORKSPACE_STATUSES)
            )
          : eq(schema.workspaces.userId, userId)
      )
      .limit(maxEntities + 1),

    listAgentActivityTasks(c.env, { userId, activeOnly, limit: maxEntities }),
  ]);
  const projectRows = projectCandidates.slice(0, maxEntities);
  const nodeRows = nodeCandidates.slice(0, maxEntities);
  const workspaceRows = workspaceCandidates.slice(0, maxEntities);
  const linkProjects = projectRows.slice(0, linkProjectCap);
  const linkProjectIdsJson = JSON.stringify(linkProjects.map((project) => project.id));

  // The D1 owner join is a second scope boundary in addition to the project IDs.
  // json_each keeps the statement at three bound parameters even for large lists.
  const ideaCandidates = linkProjects.length
    ? await c.env.DATABASE.prepare(
        `SELECT tasks.id,tasks.project_id AS projectId,tasks.title,tasks.status,tasks.updated_at AS updatedAt
         FROM tasks JOIN projects ON projects.id=tasks.project_id
         WHERE projects.user_id=? AND tasks.project_id IN (SELECT value FROM json_each(?))
           AND ${ideaTaskPredicateSql('tasks')}
         ORDER BY tasks.updated_at DESC,tasks.id DESC LIMIT ?`
      )
        .bind(userId, linkProjectIdsJson, ideaCap + 1)
        .all<{
          id: string;
          projectId: string;
          title: string;
          status: string;
          updatedAt: string | null;
        }>()
    : { results: [] };
  const candidateIdeas = ideaCandidates.results.slice(0, ideaCap);

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

      return {
        truncated: sessionsResult.total > sessionsResult.sessions.length,
        sessions: sessionsResult.sessions.map((s): SessionSummary => ({
          id: s.id as string,
          projectId: project.id,
          topic: (s.topic as string) ?? null,
          status: (s.status as string) ?? 'unknown',
          messageCount: (s.messageCount as number) ?? 0,
          workspaceId: (s.workspaceId as string) ?? null,
          taskId: (s.taskId as string) ?? null,
        })),
      };
    })
  );

  const allSessions: SessionSummary[] = [];
  let sessionsTruncated = false;
  let incomplete = false;
  for (const result of doResults) {
    if (result.status === 'fulfilled') {
      allSessions.push(...result.value.sessions);
      sessionsTruncated ||= result.value.truncated;
    } else {
      incomplete = true;
      log.warn('account_map.do_fetch_failed', { error: String(result.reason) });
    }
  }

  // Filter sessions to active-only when requested
  const filteredSessions = activeOnly
    ? allSessions.filter((s) => ACTIVE_SESSION_STATUSES.includes(s.status))
    : allSessions;

  const visibleSessions = new Map(filteredSessions.map((session) => [session.id, session]));
  const ideasByProject = new Map<string, typeof candidateIdeas>();
  for (const idea of candidateIdeas) {
    const group = ideasByProject.get(idea.projectId) ?? [];
    group.push(idea);
    ideasByProject.set(idea.projectId, group);
  }
  const linkResults = await Promise.allSettled(
    [...ideasByProject].map(async ([projectId, ideas]) => ({
      projectId,
      links: await listLinksForTargets(
        c.env,
        projectId,
        'idea',
        ideas.map((idea) => idea.id)
      ),
    }))
  );
  const ideaProjectById = new Map(candidateIdeas.map((idea) => [idea.id, idea.projectId]));
  const linkedIdeaIds = new Set<string>();
  const ideaSessionEdges = new Map<string, Relationship>();
  let linksPossiblyTruncated = false;
  for (const result of linkResults) {
    if (result.status === 'rejected') {
      incomplete = true;
      log.warn('account_map.link_fetch_failed', { error: String(result.reason) });
      continue;
    }
    const { projectId, links } = result.value;
    const linkCounts = new Map<string, number>();
    for (const link of links) {
      if (link.sourceKind !== 'session' || link.targetKind !== 'idea') continue;
      linkCounts.set(link.targetId, (linkCounts.get(link.targetId) ?? 0) + 1);
      const session = visibleSessions.get(link.sourceId);
      if (
        !session ||
        session.projectId !== projectId ||
        ideaProjectById.get(link.targetId) !== projectId
      )
        continue;
      linkedIdeaIds.add(link.targetId);
      const key = `${link.targetId}:${session.id}`;
      const previous = ideaSessionEdges.get(key);
      const primary = link.relation === 'works_on';
      ideaSessionEdges.set(key, {
        source: link.targetId,
        target: session.id,
        type: 'idea_session',
        active: (previous?.active ?? false) || isStrongLinkRelation(link.relation),
        primary: (previous?.primary ?? false) || primary,
      });
    }
    if ([...linkCounts.values()].some((count) => count >= perTargetCap))
      linksPossiblyTruncated = true;
  }
  const ideas = candidateIdeas.filter((idea) => linkedIdeaIds.has(idea.id));

  // --- Build relationships ---
  const relationships: Relationship[] = [];

  for (const idea of ideas) {
    relationships.push({ source: idea.projectId, target: idea.id, type: 'has_idea', active: true });
  }
  relationships.push(...ideaSessionEdges.values());

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
  for (const session of filteredSessions) {
    relationships.push({
      source: session.projectId,
      target: session.id,
      type: 'has_session',
      active: session.status === 'running' || session.status === 'active',
    });
  }

  // Session → Workspace
  for (const session of filteredSessions) {
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
        active: task.agentActivityState === 'working',
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
        active: task.agentActivityState === 'working',
      });
    }
  }

  const payload = {
    projects: projectRows,
    nodes: nodeRows,
    workspaces: workspaceRows,
    sessions: filteredSessions,
    tasks: taskRows.map((t) => ({
      id: t.id,
      projectId: t.projectId,
      workspaceId: t.workspaceId,
      title: t.title,
      status: t.status,
      executionStep: t.executionStep,
      priority: t.priority,
      agentActivityState: t.agentActivityState,
    })),
    ideas: ideas.map(({ id, projectId, title, status }) => ({ id, projectId, title, status })),
    truncation: {
      projects: projectCandidates.length > maxEntities,
      linkProjects: projectRows.length > linkProjectCap,
      ideas: ideaCandidates.results.length > ideaCap,
      sessions: sessionsTruncated,
      links: linksPossiblyTruncated,
      nodes: nodeCandidates.length > maxEntities,
      workspaces: workspaceCandidates.length > maxEntities,
      tasks: taskRows.length >= maxEntities,
      incomplete,
    },
    relationships,
  };

  // --- Cache in KV (fire-and-forget) ---
  if (!incomplete) {
    void c.env.KV.put(cacheKey, JSON.stringify(payload), { expirationTtl: cacheTtl }).catch(
      (err: unknown) => log.warn('account_map.kv_cache_write_failed', { error: String(err) })
    );
  }

  return c.json(payload);
});

export { accountMapRoutes };
